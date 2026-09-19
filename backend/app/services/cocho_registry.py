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
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

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
    lendo o `sha` mais recente — não é transacional, mas a frequência de
    escrita aqui (alguém cadastrando/editando/excluindo cocho manualmente,
    nunca em campo e nunca concorrente) torna essa corrida desprezível na
    prática.
    """

    _MAX_TENTATIVAS = 5

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

    async def aclose(self) -> None:
        if self._own_client:
            await self._client.aclose()

    def _contents_url(self) -> str:
        return f"{self._base_url}/repos/{self._repo}/contents/{self._path}"

    async def _read_all(self) -> tuple[dict[str, Any], str | None]:
        """Retorna (dados, sha). `sha` é None quando o arquivo ainda não existe."""
        resp = await self._client.get(
            self._contents_url(), headers=self._headers, params={"ref": self._branch}
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
        resp = await self._client.put(
            self._contents_url(), headers=self._headers, json=payload
        )
        if resp.status_code == 409:
            raise _EscritaColidiu()
        resp.raise_for_status()

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
            dados, _sha = await self._read_all()
            return dados.get(cocho_id)

    async def list_all(self) -> list[dict[str, Any]]:
        async with self._lock:
            dados, _sha = await self._read_all()
            return list(dados.values())

    async def delete(self, cocho_id: str) -> None:
        async with self._lock:

            def _modificar(atual: dict[str, Any]) -> tuple[dict[str, Any], None]:
                # Idempotente de propósito (igual a FileCochoRegistry):
                # excluir um id que já não existe não é erro.
                atual.pop(cocho_id, None)
                return atual, None

            await self._ler_modificar_escrever(_modificar)
