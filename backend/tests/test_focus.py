from __future__ import annotations

import cv2
import numpy as np
import pytest

from app.services.focus import compute_focus_score, is_frame_sharp
from tests.conftest import make_blurry_frame, make_sharp_frame


def test_focus_score_frame_nitido_maior_que_frame_liso():
    nitido = make_sharp_frame()
    liso = make_blurry_frame()

    score_nitido = compute_focus_score(nitido)
    score_liso = compute_focus_score(liso)

    assert score_nitido > score_liso


def test_focus_score_de_frame_completamente_liso_e_proximo_de_zero():
    liso = make_blurry_frame()
    score = compute_focus_score(liso)
    assert score == pytest.approx(0.0, abs=1e-6)


def test_desfoque_simulado_com_gaussian_blur_reduz_focus_score():
    nitido = make_sharp_frame()
    desfocado = cv2.GaussianBlur(nitido, (15, 15), 10)

    score_nitido = compute_focus_score(nitido)
    score_desfocado = compute_focus_score(desfocado)

    assert score_desfocado < score_nitido


def test_is_frame_sharp_respeita_limiar():
    assert is_frame_sharp(150.0, threshold=100.0) is True
    assert is_frame_sharp(50.0, threshold=100.0) is False
    assert is_frame_sharp(100.0, threshold=100.0) is True  # limite inclusivo


def test_compute_focus_score_rejeita_frame_vazio():
    with pytest.raises(ValueError):
        compute_focus_score(np.array([]))
