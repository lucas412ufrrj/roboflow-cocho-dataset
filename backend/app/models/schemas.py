"""Modelos de dados (Pydantic) usados pela API e pelos serviços internos."""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.config import get_settings


class SplitType(str, Enum):
    train = "train"
    valid = "valid"
    test = "test"


class FrameStatus(str, Enum):
    aprovado = "aprovado"
    rejeitado_desfoque = "rejeitado_desfoque"
    rejeitado_cocho_incompleto = "rejeitado_cocho_incompleto"
    falha_upload = "falha_upload"


class CaptureFormInput(BaseModel):
    """Campos de formulário recebidos em multipart/form-data em POST /api/captures."""

    peso_kg: float = Field(..., description="Peso real do alimento no cocho, em kg.")
    tipo_alimento: str | None = Field(default=None, max_length=120)
    cocho_id: str | None = Field(default=None, max_length=120)
    observacoes: str | None = Field(default=None, max_length=1000)

    @field_validator("peso_kg")
    @classmethod
    def validate_peso_kg(cls, v: float) -> float:
        settings = get_settings()
        if v is None:
            raise ValueError("peso_kg é obrigatório.")
        if v != v:  # NaN check
            raise ValueError("peso_kg inválido (NaN).")
        if v < settings.MIN_PESO_KG:
            raise ValueError(
                f"peso_kg deve ser maior ou igual a {settings.MIN_PESO_KG} kg."
            )
        if v > settings.MAX_PESO_KG:
            raise ValueError(
                f"peso_kg deve ser menor ou igual a {settings.MAX_PESO_KG} kg."
            )
        return round(float(v), 3)

    @field_validator("tipo_alimento", "cocho_id", "observacoes", mode="before")
    @classmethod
    def blank_to_none(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


class FrameMetadata(BaseModel):
    """
    Metadados enviados ao Roboflow junto de cada frame aprovado, como JSON.

    Mantém-se peso_kg, video_id e split IGUAIS para todos os frames do mesmo vídeo.
    """

    peso_kg: float
    video_id: str
    frame_time_ms: int
    focus_score: float
    cocho_completo: bool
    tipo_alimento: str | None = None
    cocho_id: str | None = None
    observacoes: str | None = None

    def to_json_dict(self) -> dict:
        return self.model_dump(mode="json", exclude_none=False)


class FrameResult(BaseModel):
    frame_index: int
    frame_time_ms: int
    focus_score: float
    cocho_completo: bool
    status: FrameStatus
    roboflow_image_id: str | None = None
    motivo_rejeicao: str | None = None


class CaptureResponse(BaseModel):
    capture_id: str
    video_id: str
    split: SplitType
    peso_kg: float
    total_candidatos: int
    total_aprovados: int
    total_rejeitados_desfoque: int
    total_rejeitados_cocho_incompleto: int
    total_falhas_upload: int
    frames: list[FrameResult]
    idempotente_reprocessado: bool = False


class ErrorResponse(BaseModel):
    detail: str
