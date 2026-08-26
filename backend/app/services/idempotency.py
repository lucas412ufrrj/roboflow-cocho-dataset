"""
Store de idempotência para `capture_id`.

Garante que reprocessar o mesmo `capture_id` (ex.: o app tentou de novo após
timeout, mas o backend já tinha concluído) não duplica uploads no Roboflow
nem reprocessa o vídeo do zero — a resposta anterior é simplesmente devolvida.

Implementação padrão: arquivo JSON em disco (suficiente para um único
processo/worker). Para múltiplas réplicas, troque por Redis/Postgres
mantendo a mesma interface `IdempotencyStore`.
"""

from __future__ import annotations

import asyncio
import json
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any


class IdempotencyStore(ABC):
    @abstractmethod
    async def get(self, capture_id: str) -> dict[str, Any] | None:
        ...

    @abstractmethod
    async def set(self, capture_id: str, result: dict[str, Any]) -> None:
        ...


class InMemoryIdempotencyStore(IdempotencyStore):
    """Usado em testes e como fallback simples."""

    def __init__(self) -> None:
        self._data: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    async def get(self, capture_id: str) -> dict[str, Any] | None:
        async with self._lock:
            return self._data.get(capture_id)

    async def set(self, capture_id: str, result: dict[str, Any]) -> None:
        async with self._lock:
            self._data[capture_id] = result


class FileIdempotencyStore(IdempotencyStore):
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

    async def get(self, capture_id: str) -> dict[str, Any] | None:
        async with self._lock:
            data = await asyncio.to_thread(self._read_all)
            return data.get(capture_id)

    async def set(self, capture_id: str, result: dict[str, Any]) -> None:
        async with self._lock:
            def _write() -> None:
                data = self._read_all()
                data[capture_id] = result
                self._path.write_text(json.dumps(data), encoding="utf-8")

            await asyncio.to_thread(_write)
