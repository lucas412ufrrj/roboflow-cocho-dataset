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
import json
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any


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
