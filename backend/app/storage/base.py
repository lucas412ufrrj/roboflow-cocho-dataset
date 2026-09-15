"""Interface de armazenamento temporário, agnóstica de backend concreto."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Protocol

DEFAULT_STREAM_CHUNK_SIZE = 1024 * 1024  # 1MB


class AsyncReadable(Protocol):
    """Qualquer objeto com `.read(n)` assíncrono — é isso que `UploadFile`
    (FastAPI/Starlette) expõe, e é só isso que `save_stream` exige dele."""

    async def read(self, size: int = -1) -> bytes: ...


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

    async def save_stream(
        self,
        key: str,
        stream: AsyncReadable,
        *,
        max_size_bytes: int | None = None,
        chunk_size: int = DEFAULT_STREAM_CHUNK_SIZE,
    ) -> int:
        """
        Grava um stream (ex.: um `UploadFile` do FastAPI) sob `key`, lendo em
        pedaços de `chunk_size` em vez de exigir o arquivo inteiro pronto em
        memória antes de começar. Devolve o tamanho total gravado, em bytes.

        Levanta `ValueError` se o total lido ultrapassar `max_size_bytes`
        (quando informado) — a gravação é abortada assim que o limite é
        excedido, sem esperar o stream terminar.

        Implementação padrão (usada por qualquer backend que não sobrescreva
        este método, como `S3StorageBackend` hoje): ainda materializa tudo em
        memória e delega a `save_bytes`, então não economiza RAM sozinha —
        mas garante que TODO `StorageBackend` responde a essa chamada.
        `LocalStorageBackend` sobrescreve com uma versão que grava direto em
        disco, que é o ganho real de memória sob upload concorrente.
        """
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = await stream.read(chunk_size)
            if not chunk:
                break
            total += len(chunk)
            if max_size_bytes is not None and total > max_size_bytes:
                raise ValueError(
                    f"Stream excede o tamanho máximo permitido de {max_size_bytes} bytes."
                )
            chunks.append(chunk)
        await self.save_bytes(key, b"".join(chunks))
        return total
