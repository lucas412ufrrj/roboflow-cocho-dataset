"""Validações do upload de vídeo antes de qualquer processamento pesado."""

from __future__ import annotations

from dataclasses import dataclass

from app.config import Settings
from app.services.ffmpeg_utils import VideoProbeInfo


class VideoValidationError(ValueError):
    pass


@dataclass(frozen=True)
class VideoConstraints:
    max_size_bytes: int
    min_duration_s: float
    max_duration_s: float
    allowed_mime_types: tuple[str, ...]
    # Regra à parte para vídeo gravado na hora (origem="camera") — ver
    # `validate_duration` abaixo e `RECORDING_DURATION_S` em `config.py`.
    recording_duration_s: float
    recording_duration_tolerance_s: float

    @classmethod
    def from_settings(cls, settings: Settings) -> "VideoConstraints":
        return cls(
            max_size_bytes=int(settings.MAX_VIDEO_SIZE_MB * 1024 * 1024),
            min_duration_s=settings.MIN_VIDEO_DURATION_S,
            max_duration_s=settings.MAX_VIDEO_DURATION_S,
            allowed_mime_types=settings.ALLOWED_VIDEO_MIME_TYPES,
            recording_duration_s=settings.RECORDING_DURATION_S,
            recording_duration_tolerance_s=settings.RECORDING_DURATION_TOLERANCE_S,
        )


def validate_mime_type(mime_type: str, constraints: VideoConstraints) -> None:
    if mime_type not in constraints.allowed_mime_types:
        raise VideoValidationError(
            f"Tipo de arquivo não suportado: {mime_type}. "
            f"Tipos aceitos: {', '.join(constraints.allowed_mime_types)}."
        )


def validate_size(size_bytes: int, constraints: VideoConstraints) -> None:
    if size_bytes <= 0:
        raise VideoValidationError("Arquivo de vídeo vazio.")
    if size_bytes > constraints.max_size_bytes:
        max_mb = constraints.max_size_bytes / (1024 * 1024)
        raise VideoValidationError(f"Vídeo excede o tamanho máximo de {max_mb:.0f} MB.")


def validate_duration(
    probe: VideoProbeInfo, constraints: VideoConstraints, *, origem: str = "galeria"
) -> None:
    """Vídeo de galeria segue o intervalo livre de sempre (min/max). Vídeo
    gravado na hora pela câmera do app tem duração fixa por construção (a
    própria gravação corta sozinha em `RECORDING_DURATION_S`, ver
    `RecordVideoScreen.tsx`), então aqui só validamos uma margem apertada em
    volta desse alvo — não é uma faixa pensada pra quem grava escolher, é só
    tolerância contra folga da API de gravação do aparelho."""
    if origem == "camera":
        alvo = constraints.recording_duration_s
        tolerancia = constraints.recording_duration_tolerance_s
        if abs(probe.duration_s - alvo) > tolerancia:
            raise VideoValidationError(
                f"Duração do vídeo gravado ({probe.duration_s:.1f}s) fora da margem esperada "
                f"de {alvo:.1f}s ± {tolerancia:.1f}s."
            )
        return

    if probe.duration_s < constraints.min_duration_s or probe.duration_s > constraints.max_duration_s:
        raise VideoValidationError(
            f"Duração do vídeo ({probe.duration_s:.1f}s) fora do intervalo permitido "
            f"({constraints.min_duration_s:.0f}s a {constraints.max_duration_s:.0f}s)."
        )
