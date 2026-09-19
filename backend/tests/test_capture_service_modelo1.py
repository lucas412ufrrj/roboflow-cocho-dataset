"""
Testa o reenvio de frames "cocho incompleto" ao dataset do Modelo 1
(`reconhecimento-de-cocho`) — ver `CaptureService._enviar_frame_incompleto_modelo1`
e `Settings.ENVIAR_COCHO_INCOMPLETO_MODELO_1`/`ROBOFLOW_TROUGH_MAX_FRAMES_POR_CAPTURA`
em `config.py`. Usa um `FakeRoboflowClient` (sem rede) e `MockTroughValidator`
sempre reprovando, pra isolar só a lógica de gating/teto/fallback de chave e
o isolamento de falha, sem depender do modelo real de detecção.
"""

from __future__ import annotations

import numpy as np
import pytest

import app.services.capture_service as capture_service_module
from app.models.schemas import CaptureFormInput
from app.services.capture_service import CaptureService
from app.services.ffmpeg_utils import VideoProbeInfo
from app.services.frame_extractor import ExtractedFrame
from app.services.idempotency import InMemoryIdempotencyStore
from app.services.roboflow_client import RoboflowUploadError, RoboflowUploadResult
from app.services.trough_validator import MockTroughValidator
from app.storage.local_storage import LocalStorageBackend

TOTAL_FRAMES_FAKE = 6


class FakeRoboflowClient:
    """Registra as chamadas de upload (peso e Modelo 1) separadamente."""

    def __init__(self, falha_modelo1: bool = False) -> None:
        self.upload_calls = 0
        self.upload_to_project_calls: list[dict] = []
        self.falha_modelo1 = falha_modelo1

    async def upload_frame(self, *, image_bytes, filename, capture_id, metadata):
        self.upload_calls += 1
        return RoboflowUploadResult(image_id=f"img-{self.upload_calls}", raw_response={})

    async def upload_frame_to_project(
        self, *, image_bytes, filename, capture_id, project, api_key, tags
    ):
        self.upload_to_project_calls.append(
            {"filename": filename, "project": project, "api_key": api_key, "tags": tags}
        )
        if self.falha_modelo1:
            raise RoboflowUploadError("erro simulado ao subir pro Modelo 1")
        return RoboflowUploadResult(
            image_id=f"modelo1-{len(self.upload_to_project_calls)}", raw_response={}
        )


@pytest.fixture
def patched_pipeline(monkeypatch):
    """Substitui as etapas de I/O pesado por stubs determinísticos, gerando
    `TOTAL_FRAMES_FAKE` frames candidatos (todos nítidos o bastante pra
    passar do focus_score, deixando `MockTroughValidator` decidir sozinho
    se são "cocho completo")."""

    async def fake_probe_video(path):
        return VideoProbeInfo(duration_s=8.0, codec_name="h264", width=640, height=480, fps=30.0)

    async def fake_normalize(src, dst):
        return None

    def fake_needs_normalization(probe, mime_type):
        return False

    async def fake_iter_frames(path, fps):
        rng = np.random.default_rng(1)
        for i in range(TOTAL_FRAMES_FAKE):
            frame = rng.integers(0, 255, size=(64, 64, 3), dtype=np.uint8)
            yield ExtractedFrame(index=i, time_ms=i * 300, frame_bgr=frame)

    monkeypatch.setattr(capture_service_module, "probe_video", fake_probe_video)
    monkeypatch.setattr(capture_service_module, "normalize_to_h264_mp4", fake_normalize)
    monkeypatch.setattr(capture_service_module, "needs_normalization", fake_needs_normalization)
    monkeypatch.setattr(capture_service_module, "iter_frames", fake_iter_frames)
    monkeypatch.setattr(capture_service_module, "compute_focus_score", lambda frame: 500.0)


def _form(**overrides) -> CaptureFormInput:
    base = dict(
        peso_kg=15.0,
        tipo_alimento_id="tipo-01",
        tipo_alimento_nome="Ração",
        tipo_alimento_densidade_aparente_kg_l=0.6,
        cocho_id="cocho-01",
        cocho_nome="Cocho de teste",
        cocho_comprimento_cm=200.0,
        cocho_largura_cm=40.0,
        cocho_altura_cm=30.0,
        cocho_experimento="2026",
    )
    base.update(overrides)
    return CaptureFormInput(**base)


def _service(settings, tmp_path, fake_client) -> CaptureService:
    storage = LocalStorageBackend(base_path=str(tmp_path / "storage"))
    return CaptureService(
        storage=storage,
        trough_validator=MockTroughValidator(always_valid=False),
        roboflow_client=fake_client,
        idempotency_store=InMemoryIdempotencyStore(),
        settings=settings,
    )


async def test_frame_incompleto_nao_sobe_ao_modelo1_quando_flag_desligada(
    settings, tmp_path, patched_pipeline
):
    settings.ENVIAR_COCHO_INCOMPLETO_MODELO_1 = False
    fake_client = FakeRoboflowClient()
    service = _service(settings, tmp_path, fake_client)

    resposta = await service.process_capture(
        capture_id="cap-flag-off",
        video_bytes=b"fake-mp4-bytes",
        mime_type="video/mp4",
        original_filename="video.mp4",
        form=_form(),
    )

    assert resposta.total_rejeitados_cocho_incompleto == TOTAL_FRAMES_FAKE
    assert fake_client.upload_to_project_calls == []


async def test_frame_incompleto_sobe_ao_modelo1_respeitando_teto(
    settings, tmp_path, patched_pipeline
):
    settings.ENVIAR_COCHO_INCOMPLETO_MODELO_1 = True
    settings.ROBOFLOW_TROUGH_UPLOAD_PROJECT = "reconhecimento-de-cocho"
    settings.ROBOFLOW_TROUGH_API_KEY = "chave-workspace-modelo1"
    settings.ROBOFLOW_TROUGH_MAX_FRAMES_POR_CAPTURA = 2
    fake_client = FakeRoboflowClient()
    service = _service(settings, tmp_path, fake_client)

    resposta = await service.process_capture(
        capture_id="cap-teto",
        video_bytes=b"fake-mp4-bytes",
        mime_type="video/mp4",
        original_filename="video.mp4",
        form=_form(),
    )

    assert resposta.total_rejeitados_cocho_incompleto == TOTAL_FRAMES_FAKE
    # Teto respeitado: só 2 dos 6 frames incompletos foram enviados ao Modelo 1.
    assert len(fake_client.upload_to_project_calls) == 2
    for chamada in fake_client.upload_to_project_calls:
        assert chamada["project"] == "reconhecimento-de-cocho"
        assert chamada["api_key"] == "chave-workspace-modelo1"
        assert "cocho-incompleto" in chamada["tags"]
        assert "experimento-2026" in chamada["tags"]


async def test_frame_incompleto_usa_fallback_de_chave_quando_trough_key_vazia(
    settings, tmp_path, patched_pipeline
):
    settings.ENVIAR_COCHO_INCOMPLETO_MODELO_1 = True
    settings.ROBOFLOW_TROUGH_UPLOAD_PROJECT = "reconhecimento-de-cocho"
    settings.ROBOFLOW_TROUGH_API_KEY = ""  # sem chave dedicada -> cai pra ROBOFLOW_API_KEY
    settings.ROBOFLOW_TROUGH_MAX_FRAMES_POR_CAPTURA = 1
    fake_client = FakeRoboflowClient()
    service = _service(settings, tmp_path, fake_client)

    await service.process_capture(
        capture_id="cap-fallback",
        video_bytes=b"fake-mp4-bytes",
        mime_type="video/mp4",
        original_filename="video.mp4",
        form=_form(),
    )

    assert len(fake_client.upload_to_project_calls) == 1
    assert fake_client.upload_to_project_calls[0]["api_key"] == settings.ROBOFLOW_API_KEY


async def test_sem_projeto_configurado_nao_envia_nada(settings, tmp_path, patched_pipeline):
    settings.ENVIAR_COCHO_INCOMPLETO_MODELO_1 = True
    settings.ROBOFLOW_TROUGH_UPLOAD_PROJECT = ""
    settings.ROBOFLOW_TROUGH_API_KEY = "chave-workspace-modelo1"
    fake_client = FakeRoboflowClient()
    service = _service(settings, tmp_path, fake_client)

    await service.process_capture(
        capture_id="cap-sem-projeto",
        video_bytes=b"fake-mp4-bytes",
        mime_type="video/mp4",
        original_filename="video.mp4",
        form=_form(),
    )

    assert fake_client.upload_to_project_calls == []


async def test_falha_no_envio_ao_modelo1_nao_derruba_a_captura(
    settings, tmp_path, patched_pipeline
):
    settings.ENVIAR_COCHO_INCOMPLETO_MODELO_1 = True
    settings.ROBOFLOW_TROUGH_UPLOAD_PROJECT = "reconhecimento-de-cocho"
    settings.ROBOFLOW_TROUGH_API_KEY = "chave-workspace-modelo1"
    settings.ROBOFLOW_TROUGH_MAX_FRAMES_POR_CAPTURA = 3
    fake_client = FakeRoboflowClient(falha_modelo1=True)
    service = _service(settings, tmp_path, fake_client)

    resposta = await service.process_capture(
        capture_id="cap-falha-modelo1",
        video_bytes=b"fake-mp4-bytes",
        mime_type="video/mp4",
        original_filename="video.mp4",
        form=_form(),
    )

    # A falha ao subir pro Modelo 1 é melhor esforço: não conta como
    # `total_falhas_upload` (esse contador é só do dataset de peso) nem muda
    # o total de rejeitados por cocho incompleto — a captura segue normal.
    assert resposta.total_falhas_upload == 0
    assert resposta.total_rejeitados_cocho_incompleto == TOTAL_FRAMES_FAKE
