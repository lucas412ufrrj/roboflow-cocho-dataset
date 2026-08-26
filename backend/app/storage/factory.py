"""Factory de `StorageBackend` a partir da configuração da aplicação."""

from __future__ import annotations

from functools import lru_cache

from app.config import Settings, get_settings
from app.storage.base import StorageBackend
from app.storage.local_storage import LocalStorageBackend


def build_storage_backend(settings: Settings | None = None) -> StorageBackend:
    settings = settings or get_settings()

    if settings.STORAGE_BACKEND == "s3":
        # Import tardio para não exigir boto3/credenciais quando não usado.
        from app.storage.s3_storage import S3StorageBackend

        return S3StorageBackend(
            bucket=settings.S3_BUCKET,
            region=settings.S3_REGION,
            endpoint_url=settings.S3_ENDPOINT_URL,
            aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
            aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
        )

    return LocalStorageBackend(base_path=settings.LOCAL_STORAGE_PATH)


@lru_cache
def get_storage_backend() -> StorageBackend:
    return build_storage_backend()
