"""Interface de armazenamento temporário, agnóstica de backend concreto."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path


class StorageBackend(ABC):
    """
    Interface para armazenamento temporário de arquivos (vídeos e frames).

    Implementações atuais: `LocalStorageBackend`.
    Implementações futuras: `S3StorageBackend` (ver `s3_storage.py`), sem
    necessidade de alterar os serviços que consomem esta interface.
    """

    @abstractmethod
    async def save_bytes(self, key: str, data: bytes) -> str:
        """Salva `data` sob `key` e retorna um identificador/caminho do objeto."""

    @abstractmethod
    async def read_bytes(self, key: str) -> bytes:
        """Lê os bytes armazenados sob `key`."""

    @abstractmethod
    async def delete(self, key: str) -> None:
        """Remove o objeto armazenado sob `key` (silencioso se não existir)."""

    @abstractmethod
    async def local_path(self, key: str) -> Path:
        """
        Retorna um caminho de arquivo LOCAL utilizável por bibliotecas que
        exigem um arquivo em disco (OpenCV, FFmpeg). Para backends remotos
        (S3), a implementação deve baixar para um arquivo temporário local.
        """

    @abstractmethod
    async def exists(self, key: str) -> bool:
        """Verifica se um objeto existe sob `key`."""
