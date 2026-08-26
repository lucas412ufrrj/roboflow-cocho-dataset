"""
Escolha determinística de split (train/valid/test) a partir do video_id.

Usamos SHA-256(video_id) -> inteiro -> módulo 100, mapeado em faixas fixas.
Isso garante que o MESMO video_id sempre produz o MESMO split (idempotência),
e que reprocessar um vídeo nunca troca frames de partição.

Distribuição alvo: 70% train, 20% valid, 10% test.
"""

from __future__ import annotations

import hashlib

from app.models.schemas import SplitType

_TRAIN_UPPER = 70  # [0, 70) -> train      (70%)
_VALID_UPPER = 90  # [70, 90) -> valid     (20%)
# [90, 100) -> test                        (10%)


def _bucket(video_id: str) -> int:
    if not video_id:
        raise ValueError("video_id não pode ser vazio para cálculo de split.")
    digest = hashlib.sha256(video_id.encode("utf-8")).hexdigest()
    return int(digest, 16) % 100


def choose_split(video_id: str) -> SplitType:
    """Retorna o split determinístico (train/valid/test) para um video_id."""
    bucket = _bucket(video_id)
    if bucket < _TRAIN_UPPER:
        return SplitType.train
    if bucket < _VALID_UPPER:
        return SplitType.valid
    return SplitType.test
