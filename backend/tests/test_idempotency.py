from __future__ import annotations

import numpy as np
import pytest

import app.services.capture_service as capture_service_module
from app.models.schemas import CaptureFormInput
from app.services.capture_service import CaptureService
from app.services.ffmpeg_utils import VideoProbeInfo
from app.services.frame_extractor import ExtractedFrame
from app.services.idempotency import InMemoryIdempotencyStore
from app.services.roboflow_client import RoboflowUploadResult
from app.services.trough_validator import MockTroughValidator
from app.storage.local_storage import LocalStorageBackend


class FakeRoboflowClient:
    """Conta quantas vezes `upload_frame` é realmente chamado."""

    def __init__(self) -> None:
        self.upload_calls = 0

    async def upload_frame(self, *, image_bytes, filename, capture_id, metadata):
        self.upload_calls += 1
        return RoboflowUploadResult(image_id=f"img-{self.upload_calls}", raw_response={})


@pytest.fixture
def patched_pipeline(monkeypatch):
    """Substitui as etapas de I/O pesado (ffmpeg/opencv) por stubs determinísticos."""

    async def fake_probe_video(path):
        return VideoProbeInfo(duration_s=8.0, codec_name="h264", width=640, height=480, fps=30.0)

    async def fake_normalize(src, dst):
        return None

    def fake_needs_normalization(probe, mime_type):
        return False

    async def fake_extract_frames(path, fps):
        frame = np.random.default_rng(1).integers(0, 255, size=(64, 64, 3), dtype=np.uint8)
        return [ExtractedFrame(index=0, time_ms=0, frame_bgr=frame)]

    monkeypatch.setattr(capture_service_module, "probe_video", fake_probe_video)
    monkeypatch.setattr(capture_service_module, "normalize_to_h264_mp4", fake_normalize)
    monkeypatch.setattr(capture_service_module, "needs_normalization", fake_needs_normalization)
    monkeypatch.setattr(capture_service_module, "extract_frames", fake_extract_frames)
    # Focus score alto o suficiente para passar no limiar padrão dos testes.
    monkeypatch.setattr(capture_service_module, "compute_focus_score", lambda frame: 500.0)


async def test_mesmo_capture_id_nao_reenvia_frames_ao_roboflow(settings, tmp_path, patched_pipeline):
    storage = LocalStorageBackend(base_path=str(tmp_path / "storage"))
    fake_client = FakeRoboflowClient()
    service = CaptureService(
        storage=storage,
        trough_validator=MockTroughValidator(always_valid=True),
        roboflow_client=fake_client,
        idempotency_store=InMemoryIdempotencyStore(),
        settings=settings,
    )

    form = CaptureFormInput(peso_kg=15.0, tipo_alimento="Silagem")
    capture_id = "capture-fixo-123"
    video_bytes = b"fake-mp4-bytes"

    resposta_1 = await service.process_capture(
        capture_id=capture_id,
        video_bytes=video_bytes,
        mime_type="video/mp4",
        original_filename="video.mp4",
        form=form,
    )
    resposta_2 = await service.process_capture(
        capture_id=capture_id,
        video_bytes=video_bytes,
        mime_type="video/mp4",
        original_filename="video.mp4",
        form=form,
    )

    assert fake_client.upload_calls == 1  # não duplicou o upload na 2ª chamada
    assert resposta_1.idempotente_reprocessado is False
    assert resposta_2.idempotente_reprocessado is True
    assert resposta_1.capture_id == resposta_2.capture_id
    assert resposta_1.video_id == resposta_2.video_id
    assert resposta_1.split == resposta_2.split


async def test_capture_ids_diferentes_geram_video_ids_diferentes(settings, tmp_path, patched_pipeline):
    storage = LocalStorageBackend(base_path=str(tmp_path / "storage"))
    fake_client = FakeRoboflowClient()
    service = CaptureService(
        storage=storage,
        trough_validator=MockTroughValidator(always_valid=True),
        roboflow_client=fake_client,
        idempotency_store=InMemoryIdempotencyStore(),
        settings=settings,
    )

    form = CaptureFormInput(peso_kg=8.0)

    resposta_1 = await service.process_capture(
        capture_id="capture-A",
        video_bytes=b"video-a",
        mime_type="video/mp4",
        original_filename="a.mp4",
        form=form,
    )
    resposta_2 = await service.process_capture(
        capture_id="capture-B",
        video_bytes=b"video-b",
        mime_type="video/mp4",
        original_filename="b.mp4",
        form=form,
    )

    assert resposta_1.video_id != resposta_2.video_id
    assert fake_client.upload_calls == 2
