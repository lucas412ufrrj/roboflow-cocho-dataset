"""Armazenamento temporário em disco local (padrão para desenvolvimento)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from app.storage.base import StorageBackend


class LocalStorageBackend(StorageBackend):
    def __init__(self, base_path: str) -> None:
        self.base_path = Path(base_path)
        self.base_path.mkdir(parents=True, exist_ok=True)

    def _resolve(self, key: str) -> Path:
        # Evita path traversal: normaliza e garante que o resultado fica
        # dentro de `base_path`.
        candidate = (self.base_path / key).resolve()
        if not str(candidate).startswith(str(self.base_path.resolve())):
            raise ValueError(f"Chave de storage inválida: {key!r}")
        return candidate

    async def save_bytes(self, key: str, data: bytes) -> str:
        path = self._resolve(key)
        path.parent.mkdir(parents=True, exist_ok=True)

        def _write() -> None:
            with open(path, "wb") as f:
                f.write(data)

        await asyncio.to_thread(_write)
        return str(path)

    async def read_bytes(self, key: str) -> bytes:
        path = self._resolve(key)

        def _read() -> bytes:
            with open(path, "rb") as f:
                return f.read()

        return await asyncio.to_thread(_read)

    async def delete(self, key: str) -> None:
        path = self._resolve(key)

        def _delete() -> None:
            path.unlink(missing_ok=True)

        await asyncio.to_thread(_delete)

    async def local_path(self, key: str) -> Path:
        # Já é local: apenas retorna o caminho resolvido.
        return self._resolve(key)

    async def exists(self, key: str) -> bool:
        return await asyncio.to_thread(self._resolve(key).exists)
