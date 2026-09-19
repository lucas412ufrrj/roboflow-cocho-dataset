"""
Registro auxiliar de tipos de alimento cadastrados pelos aparelhos
(POST/GET /api/tipos-alimento).

Mesma lógica de `services/cocho_registry.py`: serve só para listar/reaproveitar
tipos de alimento entre aparelhos. A medida que de fato importa para o
processamento de cada vídeo vai embutida (snapshot) direto em
`CaptureFormInput` (ver `models/schemas.py`) no momento da gravação — então
este registro nunca bloqueia uma captura, mesmo que o cadastro de um tipo de
alimento específico atrase, falhe ou nunca chegue a sincronizar.

Implementações espelham exatamente as de `cocho_registry.py` (arquivo
separado, em vez de generalizar as duas em uma classe base comum, pra manter
o registro de cochos — já em produção — isolado de qualquer mudança feita
aqui). Cadastro é idempotente por `tipo_alimento_id` (gerado no aparelho):
reenviar o mesmo tipo apenas sobrescreve com os mesmos dados.
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


class TipoAlimentoRegistry(ABC):
    @abstractmethod
    async def upsert(self, tipo_alimento_id: str, dados: dict[str, Any]) -> dict[str, Any]:
        ...

    @abstractmethod
    async def get(self, tipo_alimento_id: str) -> dict[str, Any] | None:
        ...

    @abstractmethod
    async def list_all(self) -> list[dict[str, Any]]:
        ...

    @abstractmethod
    async def delete(self, tipo_alimento_id: str) -> None:
        ...


class InMemoryTipoAlimentoRegistry(TipoAlimentoRegistry):
    """Usado em testes e como fallback simples."""

    def __init__(self) -> None:
        self._data: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    async def upsert(self, tipo_alimento_id: str, dados: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            registro = {**self._data.get(tipo_alimento_id, {}), **dados}
            registro.setdefault("criado_em", int(time.time() * 1000))
            self._data[tipo_alimento_id] = registro
            return registro

    async def get(self, tipo_alimento_id: str) -> dict[str, Any] | None:
        async with self._lock:
            return self._data.get(tipo_alimento_id)

    async def list_all(self) -> list[dict[str, Any]]:
        async with self._lock:
            return list(self._data.values())

    async def delete(self, tipo_alimento_id: str) -> None:
        async with self._lock:
            self._data.pop(tipo_alimento_id, None)


class FileTipoAlimentoRegistry(TipoAlimentoRegistry):
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

    async def upsert(self, tipo_alimento_id: str, dados: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            def _write() -> dict[str, Any]:
                data = self._read_all()
                registro = {**data.get(tipo_alimento_id, {}), **dados}
                registro.setdefault("criado_em", int(time.time() * 1000))
                data[tipo_alimento_id] = registro
                self._path.write_text(json.dumps(data), encoding="utf-8")
                return registro

            return await asyncio.to_thread(_write)

    async def get(self, tipo_alimento_id: str) -> dict[str, Any] | None:
        async with self._lock:
            data = await asyncio.to_thread(self._read_all)
            return data.get(tipo_alimento_id)

    async def list_all(self) -> list[dict[str, Any]]:
        async with self._lock:
            data = await asyncio.to_thread(self._read_all)
            return list(data.values())

    async def delete(self, tipo_alimento_id: str) -> None:
        async with self._lock:
            def _write() -> None:
                data = self._read_all()
                # Idempotente de propósito (igual ao upsert): excluir um id
                # que já não existe (ex.: reenvio depois de uma resposta de
                # rede perdida) não é erro, só não faz nada.
                data.pop(tipo_alimento_id, None)
                self._path.write_text(json.dumps(data), encoding="utf-8")

            await asyncio.to_thread(_write)


class _EscritaColidiu(Exception):
    """Uso interno de GitHubTipoAlimentoRegistry: sinaliza HTTP 409 (sha desatualizado)."""


class GitHubTipoAlimentoRegistry(TipoAlimentoRegistry):
    """
    Mesma lógica de `GitHubCochoRegistry` (ver `cocho_registry.py`), registro
    separado: guarda o registro de tipos de alimento como um JSON dentro do
    próprio repositório git, via API REST do GitHub (Contents API).
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
                "TIPO_ALIMENTO_REGISTRY_BACKEND=github."
            )
        if not repo:
            raise ValueError(
                "GITHUB_REPO vazio — obrigatório quando "
                'TIPO_ALIMENTO_REGISTRY_BACKEND=github (formato "usuario/repositorio").'
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
            "message": "chore(tipos-alimento): atualiza registro",
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
            "Não foi possível gravar o registro de tipos de alimento no "
            "GitHub: conflito de concorrência (HTTP 409) persistiu após "
            "várias tentativas."
        ) from erro

    async def upsert(self, tipo_alimento_id: str, dados: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:

            def _modificar(atual: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
                registro = {**atual.get(tipo_alimento_id, {}), **dados}
                registro.setdefault("criado_em", int(time.time() * 1000))
                atual[tipo_alimento_id] = registro
                return atual, registro

            return await self._ler_modificar_escrever(_modificar)

    async def get(self, tipo_alimento_id: str) -> dict[str, Any] | None:
        async with self._lock:
            dados, _sha = await self._read_all()
            return dados.get(tipo_alimento_id)

    async def list_all(self) -> list[dict[str, Any]]:
        async with self._lock:
            dados, _sha = await self._read_all()
            return list(dados.values())

    async def delete(self, tipo_alimento_id: str) -> None:
        async with self._lock:

            def _modificar(atual: dict[str, Any]) -> tuple[dict[str, Any], None]:
                # Idempotente de propósito (igual a FileTipoAlimentoRegistry):
                # excluir um id que já não existe não é erro.
                atual.pop(tipo_alimento_id, None)
                return atual, None

            await self._ler_modificar_escrever(_modificar)
