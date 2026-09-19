"""Fábricas de dependências injetadas nas rotas FastAPI."""

from __future__ import annotations

from functools import lru_cache

from app.config import get_settings
from app.services.capture_service import CaptureService
from app.services.chunked_upload_service import ChunkedUploadService
from app.services.cocho_registry import (
    CochoRegistry,
    FileCochoRegistry,
    GitHubCochoRegistry,
)
from app.services.idempotency import FileIdempotencyStore, IdempotencyStore
from app.services.roboflow_client import RoboflowClient
from app.services.tipo_alimento_registry import (
    FileTipoAlimentoRegistry,
    GitHubTipoAlimentoRegistry,
    TipoAlimentoRegistry,
)
from app.services.trough_validator import get_trough_validator
from app.storage.factory import get_storage_backend


@lru_cache
def get_idempotency_store() -> IdempotencyStore:
    # PERSISTENT_DATA_PATH (não LOCAL_STORAGE_PATH, que é só scratch de vídeo
    # em processamento, apagado a cada deploy no Render) — ver comentário em
    # `config.Settings.PERSISTENT_DATA_PATH`.
    settings = get_settings()
    path = f"{settings.PERSISTENT_DATA_PATH}/_idempotency.json"
    return FileIdempotencyStore(path)


@lru_cache
def get_cocho_registry() -> CochoRegistry:
    # COCHO_REGISTRY_BACKEND=github evita depender de PERSISTENT_DATA_PATH
    # apontar pra um Persistent Disk pago do Render — ver comentário em
    # `config.Settings.COCHO_REGISTRY_BACKEND` e decisão registrada no
    # projeto Claude (2026-09-19). `FileIdempotencyStore` continua em
    # PERSISTENT_DATA_PATH de propósito — não sofreu o mesmo incidente e o
    # impacto de resetar é bem menor.
    settings = get_settings()
    if settings.COCHO_REGISTRY_BACKEND == "github":
        return GitHubCochoRegistry(
            token=settings.GITHUB_TOKEN,
            repo=settings.GITHUB_REPO,
            path=settings.GITHUB_COCHOS_PATH,
            branch=settings.GITHUB_BRANCH,
        )
    path = f"{settings.PERSISTENT_DATA_PATH}/_cochos.json"
    return FileCochoRegistry(path)


@lru_cache
def get_tipo_alimento_registry() -> TipoAlimentoRegistry:
    # Mesma lógica de `get_cocho_registry` acima, registro separado.
    settings = get_settings()
    if settings.TIPO_ALIMENTO_REGISTRY_BACKEND == "github":
        return GitHubTipoAlimentoRegistry(
            token=settings.GITHUB_TOKEN,
            repo=settings.GITHUB_REPO,
            path=settings.GITHUB_TIPOS_ALIMENTO_PATH,
            branch=settings.GITHUB_BRANCH,
        )
    path = f"{settings.PERSISTENT_DATA_PATH}/_tipos_alimento.json"
    return FileTipoAlimentoRegistry(path)


@lru_cache
def get_roboflow_client() -> RoboflowClient:
    # Compartilhado entre requisições. Antes, `get_capture_service` criava um
    # `RoboflowClient` (e portanto um `httpx.AsyncClient` novo, com suas
    # próprias conexões) a cada requisição, e nunca fechava (`aclose()`)
    # nenhum deles — um vazamento de conexão por vídeo processado, que piora
    # exatamente sob upload concorrente (mais vídeos processados ao mesmo
    # tempo = mais clientes nunca fechados se acumulando). Compartilhar aqui
    # também dá reuso real do pool de conexões entre vídeos diferentes, não
    # só entre os frames de um mesmo vídeo. Fechado no shutdown do FastAPI
    # (ver `lifespan` em `app/main.py`).
    return RoboflowClient(settings=get_settings())


@lru_cache
def get_shared_trough_validator():
    # Mesmo raciocínio de `get_roboflow_client`: quando `TROUGH_VALIDATOR=
    # roboflow` (não é o padrão hoje, mas fica pronto pra quando for), a
    # implementação real também guarda seu próprio `httpx.AsyncClient`
    # interno — sem cache aqui, cada requisição criaria (e vazaria) mais um.
    # `MockTroughValidator` (o padrão) não abre nenhuma conexão, então
    # cachear não muda nada de comportamento pra ele.
    return get_trough_validator(get_settings())


def get_capture_service() -> CaptureService:
    settings = get_settings()
    return CaptureService(
        storage=get_storage_backend(),
        trough_validator=get_shared_trough_validator(),
        roboflow_client=get_roboflow_client(),
        idempotency_store=get_idempotency_store(),
        settings=settings,
    )


@lru_cache
def get_chunked_upload_service() -> ChunkedUploadService:
    # `@lru_cache` garante uma única instância por processo — importante
    # aqui porque `ChunkedUploadService` mantém um dicionário de locks em
    # memória por `capture_id` (ver `chunked_upload_service.py`), que só
    # protege contra corrida se for compartilhado entre as chamadas.
    return ChunkedUploadService(storage=get_storage_backend())
