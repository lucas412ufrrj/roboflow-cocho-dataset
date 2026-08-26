from __future__ import annotations

import numpy as np
import pytest

from app.config import Settings


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        APP_ENV="test",
        BACKEND_API_KEY="test-backend-key",
        LOCAL_STORAGE_PATH=str(tmp_path / "storage"),
        ROBOFLOW_API_KEY="test-roboflow-key",
        ROBOFLOW_WORKSPACE="lucas-da-guia-costa",
        ROBOFLOW_PROJECT="peso-de-alimento-no-cocho",
        ROBOFLOW_PROJECT_ID="Nl9vkgG54JP6KWBK4ala",
        ROBOFLOW_UPLOAD_MAX_RETRIES=3,
        FOCUS_SCORE_THRESHOLD=100.0,
        TROUGH_VALIDATOR="mock",
    )


def make_sharp_frame(size: int = 200) -> np.ndarray:
    """Gera um frame sintético com bastante detalhe de alta frequência (nítido)."""
    rng = np.random.default_rng(42)
    frame = rng.integers(0, 255, size=(size, size, 3), dtype=np.uint8)
    return frame


def make_blurry_frame(size: int = 200) -> np.ndarray:
    """Gera um frame sintético liso (praticamente sem bordas -> desfocado)."""
    frame = np.full((size, size, 3), 128, dtype=np.uint8)
    return frame
