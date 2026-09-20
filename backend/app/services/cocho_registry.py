"""
Registro auxiliar de cochos cadastrados pelos aparelhos (POST/GET /api/cochos).

Serve só para listar/reaproveitar cochos entre aparelhos. A medida que de
fato importa para o processamento de cada vídeo vai embutida (snapshot)
direto em `CaptureFormInput` (ver `models/schemas.py`) no momento da
gravação — então este registro nunca bloqueia uma captura, mesmo que o
cadastro de um cocho específico atrase, falhe ou nunca chegue a sincronizar.

Implementação padrão: arquivo JSON em disco (suficiente para um único
processo/worker), mesmo padrão de `idempotency.py`. Cadastro é idempotente
por `cocho_id` (gerado no aparelho): reenviar o mesmo cocho apenas
sobrescreve com os mesmos dados.
"""

from __future__ import annotations

import asyncio
import base64
import json
import random
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx


class CochoRegistry(ABC):
    @abstractmethod
    async def upsert(self, cocho_id: str, dados: dict[str, Any]) -> dict[str, Any]:
        ...

    @abstractmethod
    async def get(self, cocho_id: str) -> dict[str, Any] | None:
        ...

    @abstractmethod
    async def list_all(self) -> list[dict[str, Any]]:
        ...

    @abstractmethod
    async def delete(self, cocho_id: str) -> None:
        ...


class InMemoryCochoRegistry(CochoRegistry):
    """Usado em testes e como fallback simples."""

    def __init__(self) -> None:
        self._data: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    async def upsert(self, cocho_id: str, dados: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            registro = {**self._data.get(cocho_id, {}), **dados}
            registro.setdefault("criado_em", int(time.time() * 1000))
            self._data[cocho_id] = registro
            return registro

    async def get(self, cocho_id: str) -> dict[str, Any] | None:
        async with self._lock:
            return self._data.get(cocho_id)

    async def list_all(self) -> list[dict[str, Any]]:
        async with self._lock:
            return list(self._data.values())

    async def delete(self, cocho_id: str) -> None:
        async with self._lock:
            self._data.pop(cocho_id, None)


class FileCochoRegistry(CochoRegistry):
    def __init__(self, path: str) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        if not self._path.exists():
            self._path.write_text("{}", encoding="utf-8")
        self._lock = asyncio.Lock()

    def _read_all(self) -> dict[str, Any]:
        try:
            return json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, FileNotFoundError):
            return {}

    async def upsert(self, cocho_id: str, dados: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            def _write() -> dict[str, Any]:
                data = self._read_all()
                registro = {**data.get(cocho_id, {}), **dados}
                registro.setdefault("criado_em", int(time.time() * 1000))
                data[cocho_id] = registro
                self._path.write_text(json.dumps(data), encoding="utf-8")
                return registro

            return await asyncio.to_thread(_write)

    async def get(self, cocho_id: str) -> dict[str, Any] | None:
        async with self._lock:
            data = await asyncio.to_thread(self._read_all)
            return data.get(cocho_id)

    async def list_all(self) -> list[dict[str, Any]]:
        async with self._lock:
            data = await asyncio.to_thread(self._read_all)
            return list(data.values())

    async def delete(self, cocho_id: str) -> None:
        async with self._lock:
            def _write() -> None:
                data = self._read_all()
                # Idempotente de propósito (igual ao upsert): excluir um id
                # que já não existe (ex.: reenvio depois de uma resposta de
                # rede perdida) não é erro, só não faz nada.
                data.pop(cocho_id, None)
                self._path.write_text(json.dumps(data), encoding="utf-8")

            await asyncio.to_thread(_write)


class _EscritaColidiu(Exception):
    """Uso interno de GitHubCochoRegistry: sinaliza HTTP 409 (sha desatualizado)."""


def _resposta_e_transitoria(resp: httpx.Response) -> bool:
    """
    Erro que vale a pena tentar de novo sem mudar nada no pedido: sobrecarga
    momentânea do lado do GitHub (5xx), limite de taxa "secundário"/de
    rajada (429, ou 403 quando o corpo fala em rate limit/abuse detection —
    ver docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api).
    Um 403 de credencial inválida também chega como 403, mas sem essas
    palavras no corpo — esse continua propagando na hora, tentar de novo não
    resolveria nada.
    """
    if resp.status_code in (429, 500, 502, 503, 504):
        return True
    if resp.status_code == 403:
        corpo = resp.text.lower()
        return "rate limit" in corpo or "abuse" in corpo or "retry-after" in resp.headers
    return False


class GitHubCochoRegistry(CochoRegistry):
    """
    Alternativa DURÁVEL e gratuita ao Persistent Disk pago do Render: guarda
    o registro de cochos como um arquivo JSON dentro do próprio repositório
    git, lido/escrito via API REST do GitHub (Contents API:
    GET/PUT /repos/{repo}/contents/{path}). Um commit no GitHub nunca é
    apagado por um deploy do Render — e ao contrário de bancos "free tier"
    pesquisados como alternativa (MongoDB Atlas M0, Upstash Redis), não
    pausa/expira depois de dias sem uso, o que importa aqui porque o app é
    usado de forma sazonal em campo, com períodos longos sem nenhum acesso.

    Mesma semântica pública de FileCochoRegistry (upsert faz merge raso com
    o registro existente e preenche `criado_em` só na primeira vez; delete é
    idempotente). A diferença fica só em como persiste: cada escrita é um
    GET (pega o conteúdo e o `sha` atuais) seguido de um PUT (grava o novo
    conteúdo condicionado a esse `sha`). Se outra escrita colidir no meio
    (GitHub responde HTTP 409 porque o `sha` mudou), a gente tenta de novo
    lendo o `sha` mais recente — hoje só o Lucas tem a chave de admin que
    permite escrever (ver `adminKey.ts` no app), então essa corrida entre
    ESCRITAS continua rara na prática. Já leituras (`GET`, sem exigir chave
    de admin) podem vir de vários aparelhos ao mesmo tempo — o cenário real
    é a equipe inteira instalando/abrindo o app pela primeira vez logo depois
    de uma build nova ser publicada — e por isso têm um cache curto (ver
    `_read_all_cached`) além da mesma tolerância a erro transitório que as
    escritas (ver `_com_retry_transitorio`), pra aguentar essa rajada sem
    depender da API do GitHub responder instantaneamente a todo mundo.
    """

    _MAX_TENTATIVAS = 5
    # TTL do cache de leitura (só usado por `get`/`list_all`, nunca dentro do
    # ciclo ler-modificar-escrever de uma escrita — ver `_read_all_cached` e
    # `_ler_modificar_escrever`). Uma escrita bem-sucedida invalida o cache
    # na hora (`_invalidar_cache`), então quem acabou de cadastrar/editar/
    # excluir um cocho sempre vê o resultado mesmo lendo de novo em seguida;
    # o TTL só limita por quanto tempo um OUTRO aparelho pode ver uma versão
    # levemente desatualizada, o que é uma troca aceitável pra não martelar o
    # GitHub com dezenas de GETs idênticos no mesmo segundo.
    _CACHE_TTL_S = 5.0
    # Espera-base entre tentativas diante de erro transitório — cresce
    # exponencialmente (0.4s, 0.8s, 1.6s...) com um pouco de variação
    # aleatória, pra não fazer vários aparelhos tentarem de novo exatamente
    # no mesmo instante depois de uma falha em comum do lado do GitHub.
    _BACKOFF_BASE_S = 0.4

    def __init__(
        self,
        *,
        token: str,
        repo: str,
        path: str,
        branch: str = "main",
        base_url: str = "https://api.github.com",
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not token:
            raise ValueError(
                "GITHUB_TOKEN vazio — obrigatório quando "
                "COCHO_REGISTRY_BACKEND=github."
            )
        if not repo:
            raise ValueError(
                "GITHUB_REPO vazio — obrigatório quando "
                'COCHO_REGISTRY_BACKEND=github (formato "usuario/repositorio").'
            )
        self._repo = repo
        self._path = path.lstrip("/")
        self._branch = branch
        self._base_url = base_url.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        # Se ninguém passar um client (caso normal em produção), criamos e
        # também fechamos o nosso — em teste, passar um client (ex.: com
        # MockTransport) evita abrir conexão real e deixa o teste dono dele.
        self._own_client = client is None
        self._client = client or httpx.AsyncClient(timeout=15.0)
        self._lock = asyncio.Lock()
        # (dados, sha, quando) da última leitura bem-sucedida — ver
        # `_read_all_cached`. `None` até a primeira leitura, ou depois de
        # qualquer escrita bem-sucedida (`_invalidar_cache`).
        self._cache: tuple[dict[str, Any], str | None, float] | None = None

    async def aclose(self) -> None:
        if self._own_client:
            await self._client.aclose()

    def _contents_url(self) -> str:
        return f"{self._base_url}/repos/{self._repo}/contents/{self._path}"

    def _invalidar_cache(self) -> None:
        self._cache = None

    async def _com_retry_transitorio(
        self, fazer: Callable[[], Awaitable[httpx.Response]], *, tentativas: int = 3
    ) -> httpx.Response:
        """
        Repete uma chamada HTTP (`fazer`) diante de falha transitória — erro
        de rede/timeout, ou resposta que `_resposta_e_transitoria` considera
        passageira — com espera crescente entre tentativas. Não decide se a
        resposta final é um erro de verdade (404, 401, 409...): isso continua
        por conta de quem chama, via `raise_for_status()`/checagem explícita,
        exatamente como antes. O 409 de conflito de `sha` NUNCA passa por
        aqui — ele precisa reler o conteúdo mais novo antes de tentar de
        novo, não só esperar e repetir o mesmo PUT (ver
        `_ler_modificar_escrever`).
        """
        ultima_resposta: httpx.Response | None = None
        ultimo_erro: Exception | None = None
        for tentativa in range(tentativas):
            try:
                resp = await fazer()
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                ultimo_erro = exc
            else:
                if not _resposta_e_transitoria(resp):
                    return resp
                ultima_resposta = resp
            if tentativa < tentativas - 1:
                espera = self._BACKOFF_BASE_S * (2**tentativa) + random.uniform(0, 0.2)
                await asyncio.sleep(espera)
        if ultima_resposta is not None:
            # Devolve a última resposta (mesmo transitória) pra quem chama
            # levantar o erro de verdade do jeito de sempre (`raise_for_status`).
            return ultima_resposta
        raise RuntimeError(
            "Falha de rede ao falar com a API do GitHub após várias tentativas."
        ) from ultimo_erro

    async def _read_all(self) -> tuple[dict[str, Any], str | None]:
        """Leitura sempre fresca (sem cache) — usada dentro do ciclo
        ler-modificar-escrever de uma escrita, que precisa do `sha` real e
        atual (ver `_ler_modificar_escrever`), e por `_read_all_cached`
        abaixo quando o cache expirou ou ainda não existe. Retorna
        (dados, sha); `sha` é None quando o arquivo ainda não existe."""
        resp = await self._com_retry_transitorio(
            lambda: self._client.get(
                self._contents_url(), headers=self._headers, params={"ref": self._branch}
            )
        )
        if resp.status_code == 404:
            return {}, None
        resp.raise_for_status()
        body = resp.json()
        sha = body.get("sha")
        bruto = base64.b64decode(body.get("content", "") or "")
        try:
            dados = json.loads(bruto.decode("utf-8")) if bruto else {}
        except json.JSONDecodeError:
            dados = {}
        return dados, sha

    async def _read_all_cached(self) -> tuple[dict[str, Any], str | None]:
        """Mesmo retorno de `_read_all`, mas reaproveita uma leitura recente
        (ver `_CACHE_TTL_S`) em vez de bater na API do GitHub toda vez — só
        pra `get`/`list_all` (leitura pura), nunca pro ciclo de escrita."""
        agora = time.monotonic()
        if self._cache is not None:
            dados, sha, quando = self._cache
            if agora - quando < self._CACHE_TTL_S:
                return dados, sha
        dados, sha = await self._read_all()
        self._cache = (dados, sha, agora)
        return dados, sha

    async def _write_all(self, dados: dict[str, Any], sha: str | None) -> None:
        payload: dict[str, Any] = {
            "message": "chore(cochos): atualiza registro",
            "content": base64.b64encode(
                json.dumps(dados, ensure_ascii=False, indent=2).encode("utf-8")
            ).decode("ascii"),
            "branch": self._branch,
        }
        if sha is not None:
            payload["sha"] = sha
        resp = await self._com_retry_transitorio(
            lambda: self._client.put(self._contents_url(), headers=self._headers, json=payload)
        )
        if resp.status_code == 409:
            raise _EscritaColidiu()
        resp.raise_for_status()
        # Sucesso: qualquer leitura em cache está desatualizada a partir de
        # agora — invalida pra quem ler em seguida (inclusive este mesmo
        # aparelho) ver o resultado desta escrita, não uma versão anterior.
        self._invalidar_cache()

    async def _ler_modificar_escrever(self, modificar: Any) -> Any:
        erro: Exception | None = None
        for _tentativa in range(self._MAX_TENTATIVAS):
            dados, sha = await self._read_all()
            dados_novos, retorno = modificar(dados)
            try:
                await self._write_all(dados_novos, sha)
                return retorno
            except _EscritaColidiu as exc:
                erro = exc
                continue
        raise RuntimeError(
            "Não foi possível gravar o registro de cochos no GitHub: "
            "conflito de concorrência (HTTP 409) persistiu após várias "
            "tentativas."
        ) from erro

    async def upsert(self, cocho_id: str, dados: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:

            def _modificar(atual: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
                registro = {**atual.get(cocho_id, {}), **dados}
                registro.setdefault("criado_em", int(time.time() * 1000))
                atual[cocho_id] = registro
                return atual, registro

            return await self._ler_modificar_escrever(_modificar)

    async def get(self, cocho_id: str) -> dict[str, Any] | None:
        async with self._lock:
            dados, _sha = await self._read_all_cached()
            return dados.get(cocho_id)

    async def list_all(self) -> list[dict[str, Any]]:
        async with self._lock:
            dados, _sha = await self._read_all_cached()
            return list(dados.values())

    async def delete(self, cocho_id: str) -> None:
        async with self._lock:

            def _modificar(atual: dict[str, Any]) -> tuple[dict[str, Any], None]:
                # Idempotente de propósito (igual a FileCochoRegistry):
                # excluir um id que já não existe não é erro.
                atual.pop(cocho_id, None)
                return atual, None

            await self._ler_modificar_escrever(_modificar)
