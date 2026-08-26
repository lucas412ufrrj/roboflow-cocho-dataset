"""Fábricas de dependências injetadas nas rotas FastAPI."""

from __future__ import annotations

from functools import lru_cache

from app.config import get_settings
from app.services.capture_service import CaptureService
from app.services.idempotency import FileIdempotencyStore, IdempotencyStore
from app.services.roboflow_client import RoboflowClient
from app.services.trough_validator import get_trough_validator
from app.storage.factory import get_storage_backend


@lru_cache
def get_idempotency_store() -> IdempotencyStore:
    settings = get_settings()
    path = f"{settings.LOCAL_STORAGE_PATH}/_idempotency.json"
    return FileIdempotencyStore(path)


def get_capture_service() -> CaptureService:
    settings = get_settings()
    return CaptureService(
        storage=get_storage_backend(),
        trough_validator=get_trough_validator(settings),
        roboflow_client=RoboflowClient(settings=settings),
        idempotency_store=get_idempotency_store(),
        settings=settings,
    )
