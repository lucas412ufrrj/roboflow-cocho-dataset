"""
Configurações centrais da aplicação.

Todos os segredos (em especial ROBOFLOW_API_KEY) são carregados exclusivamente
de variáveis de ambiente no backend. NUNCA exponha `ROBOFLOW_API_KEY` em
respostas de API, logs ou para o aplicativo móvel.
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Aplicação ---
    APP_NAME: str = "roboflow-cocho-capture-backend"
    APP_ENV: Literal["development", "staging", "production", "test"] = "development"
    LOG_LEVEL: str = "INFO"

    # --- Autenticação do app móvel no NOSSO backend (nunca no Roboflow) ---
    BACKEND_API_KEY: str = Field(
        default="change-me-backend-api-key",
        description="Chave usada pelo app móvel para autenticar no backend.",
    )

    # --- Rate limiting ---
    RATE_LIMIT_CAPTURES: str = "10/minute"

    # --- Upload / vídeo ---
    MAX_VIDEO_SIZE_MB: float = 150.0
    MIN_VIDEO_DURATION_S: float = 7.0
    MAX_VIDEO_DURATION_S: float = 10.0
    ALLOWED_VIDEO_MIME_TYPES: tuple[str, ...] = (
        "video/mp4",
        "video/quicktime",  # .mov gravado no iOS, será normalizado
        "video/x-matroska",
    )

    # --- Peso ---
    MIN_PESO_KG: float = 0.01
    MAX_PESO_KG: float = 2000.0

    # --- Extração de frames ---
    FRAMES_PER_SECOND: float = 3.0
    FOCUS_SCORE_THRESHOLD: float = 100.0  # variância do Laplaciano

    # --- Armazenamento temporário ---
    STORAGE_BACKEND: Literal["local", "s3"] = "local"
    LOCAL_STORAGE_PATH: str = "./tmp_storage"

    # S3 (usado somente quando STORAGE_BACKEND=s3)
    S3_BUCKET: str = ""
    S3_REGION: str = "us-east-1"
    S3_ENDPOINT_URL: str | None = None
    AWS_ACCESS_KEY_ID: str | None = None
    AWS_SECRET_ACCESS_KEY: str | None = None

    # --- Roboflow (workspace/projeto NÃO são segredos, a chave é) ---
    ROBOFLOW_API_KEY: str = Field(
        default="",
        description="Chave privada do Roboflow. Somente no backend. NUNCA logar.",
    )
    ROBOFLOW_WORKSPACE: str = "lucas-da-guia-costa"
    ROBOFLOW_PROJECT: str = "peso-de-alimento-no-cocho"
    ROBOFLOW_PROJECT_ID: str = "Nl9vkgG54JP6KWBK4ala"
    ROBOFLOW_UPLOAD_BASE_URL: str = "https://api.roboflow.com"
    ROBOFLOW_UPLOAD_TIMEOUT_S: float = 30.0
    ROBOFLOW_UPLOAD_MAX_RETRIES: int = 4

    # --- Validador de cocho ---
    TROUGH_VALIDATOR: Literal["mock", "roboflow"] = "mock"
    TROUGH_VALIDATOR_MOCK_ALWAYS_VALID: bool = True
    TROUGH_VALIDATOR_MOCK_CONFIDENCE: float = 0.95
    ROBOFLOW_TROUGH_MODEL_ID: str = ""  # ex: "cocho-integrity/1"
    ROBOFLOW_TROUGH_CONFIDENCE_THRESHOLD: float = 0.5

    @field_validator("ROBOFLOW_API_KEY")
    @classmethod
    def _warn_empty_key_in_prod(cls, v: str, info) -> str:
        # Não lança erro aqui (para permitir testes sem a chave), mas o
        # RoboflowTroughValidator/RoboflowClient reais devem validar antes de operar.
        return v


@lru_cache
def get_settings() -> Settings:
    return Settings()
