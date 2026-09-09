from __future__ import annotations

import base64

import httpx
import respx

from app.services.trough_validator import RoboflowTroughValidator
from tests.conftest import make_sharp_frame


def _prediction(class_name: str, confidence: float) -> dict:
    return {"class": class_name, "confidence": confidence}


@respx.mock
async def test_cocho_completo_quando_trough_e_duas_extremidades_fortes(settings):
    settings.TROUGH_VALIDATOR = "roboflow"
    settings.ROBOFLOW_TROUGH_MODEL_ID = "reconhecimento-de-cocho/13"
    settings.ROBOFLOW_TROUGH_CONFIDENCE_THRESHOLD = 0.5

    url = f"{settings.ROBOFLOW_INFERENCE_BASE_URL}/{settings.ROBOFLOW_TROUGH_MODEL_ID}"
    route = respx.post(url).mock(
        return_value=httpx.Response(
            200,
            json={
                "predictions": [
                    _prediction("trough", 0.97),
                    _prediction("trough_end", 0.90),
                    _prediction("trough_end", 0.55),
                ]
            },
        )
    )

    validator = RoboflowTroughValidator(settings=settings)
    result = await validator.validate(make_sharp_frame())

    assert route.called
    assert result.cocho_completo is True
    # confiança reportada é a da extremidade mais fraca das duas usadas (o elo limitante)
    assert result.confidence == 0.55
    await validator.aclose()


@respx.mock
async def test_cocho_incompleto_com_apenas_uma_extremidade_forte(settings):
    settings.TROUGH_VALIDATOR = "roboflow"
    settings.ROBOFLOW_TROUGH_MODEL_ID = "reconhecimento-de-cocho/13"
    settings.ROBOFLOW_TROUGH_CONFIDENCE_THRESHOLD = 0.5

    url = f"{settings.ROBOFLOW_INFERENCE_BASE_URL}/{settings.ROBOFLOW_TROUGH_MODEL_ID}"
    respx.post(url).mock(
        return_value=httpx.Response(
            200,
            json={
                "predictions": [
                    _prediction("trough", 0.97),
                    _prediction("trough_end", 0.43),  # abaixo do limiar
                    _prediction("trough_end", 0.90),
                ]
            },
        )
    )

    validator = RoboflowTroughValidator(settings=settings)
    result = await validator.validate(make_sharp_frame())

    assert result.cocho_completo is False
    assert "1_extremidade" in result.motivo
    await validator.aclose()


@respx.mock
async def test_cocho_incompleto_quando_trough_nao_e_detectado(settings):
    settings.TROUGH_VALIDATOR = "roboflow"
    settings.ROBOFLOW_TROUGH_MODEL_ID = "reconhecimento-de-cocho/13"

    url = f"{settings.ROBOFLOW_INFERENCE_BASE_URL}/{settings.ROBOFLOW_TROUGH_MODEL_ID}"
    respx.post(url).mock(
        return_value=httpx.Response(
            200,
            json={
                "predictions": [
                    _prediction("trough_end", 0.90),
                    _prediction("trough_end", 0.90),
                ]
            },
        )
    )

    validator = RoboflowTroughValidator(settings=settings)
    result = await validator.validate(make_sharp_frame())

    assert result.cocho_completo is False
    assert result.motivo == "cocho_nao_detectado (roboflow)"
    await validator.aclose()


@respx.mock
async def test_envia_imagem_como_base64_no_corpo(settings):
    settings.TROUGH_VALIDATOR = "roboflow"
    settings.ROBOFLOW_TROUGH_MODEL_ID = "reconhecimento-de-cocho/13"

    url = f"{settings.ROBOFLOW_INFERENCE_BASE_URL}/{settings.ROBOFLOW_TROUGH_MODEL_ID}"
    route = respx.post(url).mock(return_value=httpx.Response(200, json={"predictions": []}))

    validator = RoboflowTroughValidator(settings=settings)
    await validator.validate(make_sharp_frame())

    request = route.calls.last.request
    assert request.headers["content-type"] == "application/x-www-form-urlencoded"
    # o corpo precisa decodificar como base64 válido (bytes de uma imagem), não bytes crus.
    base64.b64decode(request.content, validate=True)
    await validator.aclose()


@respx.mock
async def test_usa_chave_dedicada_do_workspace_do_modelo_quando_configurada(settings):
    settings.TROUGH_VALIDATOR = "roboflow"
    settings.ROBOFLOW_TROUGH_MODEL_ID = "reconhecimento-de-cocho/13"
    settings.ROBOFLOW_TROUGH_API_KEY = "chave-do-workspace-lucass-workspace-mmecb"

    url = f"{settings.ROBOFLOW_INFERENCE_BASE_URL}/{settings.ROBOFLOW_TROUGH_MODEL_ID}"
    route = respx.post(url).mock(return_value=httpx.Response(200, json={"predictions": []}))

    validator = RoboflowTroughValidator(settings=settings)
    await validator.validate(make_sharp_frame())

    request = route.calls.last.request
    assert request.url.params["api_key"] == "chave-do-workspace-lucass-workspace-mmecb"
    assert request.url.params["api_key"] != settings.ROBOFLOW_API_KEY
    await validator.aclose()
