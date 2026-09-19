from __future__ import annotations

import httpx
import pytest
import respx

from app.models.schemas import FrameMetadata
from app.services.roboflow_client import RoboflowClient, RoboflowUploadError


def _metadata(**overrides) -> FrameMetadata:
    base = dict(
        peso_kg=25.0,
        video_id="video-1",
        frame_time_ms=1000,
        focus_score=180.0,
        cocho_completo=True,
        tipo_alimento="Ração",
        cocho_id="cocho-01",
        cocho_nome="Cocho de teste",
        cocho_comprimento_cm=200.0,
        cocho_largura_cm=40.0,
        cocho_altura_cm=30.0,
        cocho_experimento="2026",
        observacoes=None,
    )
    base.update(overrides)
    return FrameMetadata(**base)


@respx.mock
async def test_upload_frame_sucesso_envia_tags_e_metadata_corretos(settings):
    upload_url = (
        f"{settings.ROBOFLOW_UPLOAD_BASE_URL}/dataset/{settings.ROBOFLOW_PROJECT}/upload"
    )
    route = respx.post(upload_url).mock(
        return_value=httpx.Response(200, json={"id": "img-abc123", "duplicate": False})
    )

    client = RoboflowClient(settings=settings)
    metadata = _metadata()

    result = await client.upload_frame(
        image_bytes=b"fake-jpeg-bytes",
        filename="video-1_000.jpg",
        capture_id="capture-xyz",
        metadata=metadata,
    )

    assert route.called
    request = route.calls.last.request
    assert request.url.params["batch_name"] == "capture-xyz"
    assert request.url.params["api_key"] == settings.ROBOFLOW_API_KEY
    tags = request.url.params.get_list("tag")
    assert "mobile-capture" in tags
    assert "frame-valid" in tags
    assert "Ração" in tags
    assert "experimento-2026" in tags

    assert result.image_id == "img-abc123"
    await client.aclose()


@respx.mock
async def test_upload_frame_nunca_loga_a_api_key(settings, caplog):
    upload_url = (
        f"{settings.ROBOFLOW_UPLOAD_BASE_URL}/dataset/{settings.ROBOFLOW_PROJECT}/upload"
    )
    respx.post(upload_url).mock(return_value=httpx.Response(500, text="erro interno"))

    client = RoboflowClient(settings=settings)
    settings.ROBOFLOW_UPLOAD_MAX_RETRIES = 1

    with pytest.raises(RoboflowUploadError):
        await client.upload_frame(
            image_bytes=b"fake",
            filename="f.jpg",
            capture_id="capture-1",
            metadata=_metadata(),
        )

    for record in caplog.records:
        assert settings.ROBOFLOW_API_KEY not in record.getMessage()

    await client.aclose()


@respx.mock
async def test_upload_frame_faz_retry_em_erro_5xx_e_depois_sucede(settings):
    upload_url = (
        f"{settings.ROBOFLOW_UPLOAD_BASE_URL}/dataset/{settings.ROBOFLOW_PROJECT}/upload"
    )
    route = respx.post(upload_url).mock(
        side_effect=[
            httpx.Response(503, text="temporariamente indisponível"),
            httpx.Response(200, json={"id": "img-retry-ok"}),
        ]
    )

    client = RoboflowClient(settings=settings)
    result = await client.upload_frame(
        image_bytes=b"fake",
        filename="f.jpg",
        capture_id="capture-retry",
        metadata=_metadata(),
    )

    assert route.call_count == 2
    assert result.image_id == "img-retry-ok"
    await client.aclose()


@respx.mock
async def test_upload_frame_erro_4xx_nao_faz_retry(settings):
    upload_url = (
        f"{settings.ROBOFLOW_UPLOAD_BASE_URL}/dataset/{settings.ROBOFLOW_PROJECT}/upload"
    )
    route = respx.post(upload_url).mock(return_value=httpx.Response(400, text="payload inválido"))

    client = RoboflowClient(settings=settings)
    with pytest.raises(RoboflowUploadError):
        await client.upload_frame(
            image_bytes=b"fake",
            filename="f.jpg",
            capture_id="capture-400",
            metadata=_metadata(),
        )

    assert route.call_count == 1  # erro definitivo, sem retry
    await client.aclose()


async def test_upload_frame_sem_api_key_falha_imediatamente(settings):
    settings.ROBOFLOW_API_KEY = ""
    client = RoboflowClient(settings=settings)

    with pytest.raises(RoboflowUploadError):
        await client.upload_frame(
            image_bytes=b"fake",
            filename="f.jpg",
            capture_id="capture-sem-chave",
            metadata=_metadata(),
        )
    await client.aclose()


@respx.mock
async def test_upload_frame_to_project_envia_ao_projeto_e_chave_informados(settings):
    # Projeto/chave diferentes dos padrões do dataset de peso — é assim que
    # `capture_service.py` usa isso pra reenviar frame de "cocho incompleto"
    # ao dataset do Modelo 1, num workspace potencialmente diferente.
    upload_url = f"{settings.ROBOFLOW_UPLOAD_BASE_URL}/dataset/reconhecimento-de-cocho/upload"
    route = respx.post(upload_url).mock(
        return_value=httpx.Response(200, json={"id": "img-modelo1-1"})
    )

    client = RoboflowClient(settings=settings)
    result = await client.upload_frame_to_project(
        image_bytes=b"fake-jpeg-bytes",
        filename="video-1_000_incompleto.jpg",
        capture_id="capture-xyz",
        project="reconhecimento-de-cocho",
        api_key="chave-workspace-modelo1",
        tags=["cocho-incompleto", "cocho-nao-detectado", "experimento-2026"],
    )

    assert route.called
    request = route.calls.last.request
    assert request.url.params["batch_name"] == "capture-xyz"
    assert request.url.params["api_key"] == "chave-workspace-modelo1"
    tags = request.url.params.get_list("tag")
    assert "cocho-incompleto" in tags
    assert "cocho-nao-detectado" in tags
    assert "experimento-2026" in tags
    # Esse dataset não usa o schema de FrameMetadata — não deve ir "metadata" nenhum.
    assert b"name=\"metadata\"" not in request.content

    assert result.image_id == "img-modelo1-1"
    await client.aclose()


async def test_upload_frame_to_project_sem_api_key_falha_imediatamente(settings):
    client = RoboflowClient(settings=settings)

    with pytest.raises(RoboflowUploadError):
        await client.upload_frame_to_project(
            image_bytes=b"fake",
            filename="f.jpg",
            capture_id="capture-sem-chave",
            project="reconhecimento-de-cocho",
            api_key="",
            tags=["cocho-incompleto"],
        )
    await client.aclose()
