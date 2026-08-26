"""
Backend de armazenamento S3 — MESMA interface de `LocalStorageBackend`.

Este stub já implementa as operações usando boto3, para que trocar
`STORAGE_BACKEND=local` -> `STORAGE_BACKEND=s3` no `.env` seja suficiente
(ver `app/storage/factory.py`). Nenhum outro módulo da aplicação depende de
detalhes concretos de armazenamento — todos usam `StorageBackend`.
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from app.storage.base import StorageBackend


class S3StorageBackend(StorageBackend):
    def __init__(
        self,
        bucket: str,
        region: str,
        endpoint_url: str | None = None,
        aws_access_key_id: str | None = None,
        aws_secret_access_key: str | None = None,
    ) -> None:
        if not bucket:
            raise ValueError("S3_BUCKET é obrigatório para usar STORAGE_BACKEND=s3.")

        import boto3  # import tardio: só é necessário quando S3 é usado de fato

        self.bucket = bucket
        self._client = boto3.client(
            "s3",
            region_name=region,
            endpoint_url=endpoint_url,
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
        )
        self._local_cache_dir = Path(tempfile.mkdtemp(prefix="s3-cache-"))

    async def save_bytes(self, key: str, data: bytes) -> str:
        def _put() -> None:
            self._client.put_object(Bucket=self.bucket, Key=key, Body=data)

        await asyncio.to_thread(_put)
        return f"s3://{self.bucket}/{key}"

    async def read_bytes(self, key: str) -> bytes:
        def _get() -> bytes:
            obj = self._client.get_object(Bucket=self.bucket, Key=key)
            return obj["Body"].read()

        return await asyncio.to_thread(_get)

    async def delete(self, key: str) -> None:
        def _delete() -> None:
            self._client.delete_object(Bucket=self.bucket, Key=key)

        await asyncio.to_thread(_delete)

    async def local_path(self, key: str) -> Path:
        # OpenCV/FFmpeg exigem um caminho local: baixamos para um cache temporário.
        local_file = self._local_cache_dir / key.replace("/", "_")
        local_file.parent.mkdir(parents=True, exist_ok=True)

        def _download() -> None:
            self._client.download_file(self.bucket, key, str(local_file))

        await asyncio.to_thread(_download)
        return local_file

    async def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        def _head() -> bool:
            try:
                self._client.head_object(Bucket=self.bucket, Key=key)
                return True
            except ClientError:
                return False

        return await asyncio.to_thread(_head)
