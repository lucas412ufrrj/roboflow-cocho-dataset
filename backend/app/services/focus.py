"""
Métrica de nitidez de um frame: variância do operador Laplaciano.

Quanto maior a variância, mais bordas de alta frequência existem na imagem,
o que geralmente indica uma imagem em foco. Imagens borradas tendem a ter
variância baixa. O limiar é configurável via FOCUS_SCORE_THRESHOLD.
"""

from __future__ import annotations

import cv2
import numpy as np


def compute_focus_score(frame_bgr: np.ndarray) -> float:
    """Calcula a variância do Laplaciano de um frame (BGR ou grayscale)."""
    if frame_bgr is None or frame_bgr.size == 0:
        raise ValueError("Frame vazio ou inválido para cálculo de focus_score.")

    if frame_bgr.ndim == 3:
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    else:
        gray = frame_bgr

    laplacian = cv2.Laplacian(gray, cv2.CV_64F)
    return float(laplacian.var())


def is_frame_sharp(focus_score: float, threshold: float) -> bool:
    """Um frame é aceito por nitidez quando focus_score >= threshold."""
    return focus_score >= threshold
