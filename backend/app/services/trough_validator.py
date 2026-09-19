"""
Validação de "cocho completo" (trough integrity).

`TroughValidator` é a interface que qualquer implementação de validação deve
seguir. Hoje usamos `MockTroughValidator` (configurável) por padrão.
`RoboflowTroughValidator` fica pronta para chamar um Model/Workflow do
Roboflow assim que houver um modelo treinado para essa tarefa — mas nunca
expõe a chave do Roboflow fora do backend.

IMPORTANTE: esta validação NUNCA rejeita frames por similaridade ou ângulo,
apenas por "cocho incompleto" (o frame de nitidez é tratado em `focus.py`).
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass

import httpx
import numpy as np

from app.config import Settings, get_settings
from app.core.logging import redact

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TroughValidationResult:
    cocho_completo: bool
    confidence: float
    motivo: str | None = None
    # Geometria em pixel da imagem, só preenchida por `RoboflowTroughValidator`
    # (o mock não tem imagem de verdade pra medir nada). Usada por
    # `services/scale_calculator.py` pra converter pixel em centímetro — ver
    # comentário lá. `trough_polygon_px` é o contorno do cocho (lista de
    # vértices, na mesma ordem que o Roboflow devolve); `trough_end_points_px`
    # são os centros das duas extremidades usadas pra calibrar escala.
    trough_polygon_px: list[tuple[float, float]] | None = None
    trough_end_points_px: list[tuple[float, float]] | None = None


class TroughValidator(ABC):
    """Interface para validar se o cocho aparece completo/inteiro no frame."""

    @abstractmethod
    async def validate(self, frame_bgr: np.ndarray) -> TroughValidationResult:
        """Retorna se o cocho está completo no frame fornecido (BGR)."""
        raise NotImplementedError


class MockTroughValidator(TroughValidator):
    """
    Implementação mock e configurável, usada em desenvolvimento e testes.

    - `always_valid=True` (padrão): todo frame é considerado com cocho completo.
    - `always_valid=False`: todo frame é considerado com cocho incompleto.
    - `decide_fn`: função customizada `(frame) -> bool` para cenários de teste
      mais específicos, tem prioridade sobre `always_valid`.
    """

    def __init__(
        self,
        always_valid: bool = True,
        confidence: float = 0.95,
        decide_fn=None,
    ) -> None:
        self.always_valid = always_valid
        self.confidence = confidence
        self.decide_fn = decide_fn

    async def validate(self, frame_bgr: np.ndarray) -> TroughValidationResult:
        if self.decide_fn is not None:
            cocho_completo = bool(self.decide_fn(frame_bgr))
        else:
            cocho_completo = self.always_valid

        motivo = None if cocho_completo else "cocho_incompleto (mock)"
        return TroughValidationResult(
            cocho_completo=cocho_completo,
            confidence=self.confidence,
            motivo=motivo,
        )


class RoboflowTroughValidator(TroughValidator):
    """
    Implementação real: chama o modelo de segmentação de instâncias
    `reconhecimento-de-cocho` (workspace `lucass-workspace-mmecb`), treinado
    com duas classes: `trough` (o cocho inteiro) e `trough_end` (cada
    extremidade — uma única classe genérica, sem distinção de lado, ver
    decisão registrada no projeto Roboflow em 2026-09-09).

    Regra de "cocho completo" usada aqui: existe pelo menos uma predição
    `trough` no frame E pelo menos DUAS predições `trough_end` (as duas
    extremidades visíveis no mesmo frame). Isso é o que caracteriza uma foto
    de "cocho inteiro" pronta para virar dado de treino do modelo de peso —
    uma foto com só uma extremidade é fragmentada e não deve ser aprovada
    aqui (hoje esse caso simplesmente é rejeitado; reconstrução por
    panorâmica a partir de vídeo é uma etapa futura, não implementada).

    Usa `ROBOFLOW_TROUGH_API_KEY` (chave do workspace onde o modelo de
    detecção vive) quando configurada; cai para `ROBOFLOW_API_KEY` caso
    contrário — só use o fallback se os dois projetos realmente estiverem no
    mesmo workspace/conta Roboflow. Nenhuma das duas chaves é logada nem
    retornada ao cliente. Use `ROBOFLOW_TROUGH_MODEL_ID` no formato
    "projeto/versao" (ex.: "reconhecimento-de-cocho/13").
    """

    def __init__(self, settings: Settings | None = None, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings or get_settings()
        self._client = client

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.settings.ROBOFLOW_UPLOAD_TIMEOUT_S)
        return self._client

    async def validate(self, frame_bgr: np.ndarray) -> TroughValidationResult:
        if not self.settings.ROBOFLOW_TROUGH_MODEL_ID:
            raise RuntimeError(
                "ROBOFLOW_TROUGH_MODEL_ID não configurado para RoboflowTroughValidator."
            )
        api_key = self.settings.ROBOFLOW_TROUGH_API_KEY or self.settings.ROBOFLOW_API_KEY
        if not api_key:
            raise RuntimeError(
                "Nenhuma chave configurada (ROBOFLOW_TROUGH_API_KEY nem ROBOFLOW_API_KEY)."
            )

        import base64

        import cv2

        ok, buffer = cv2.imencode(".jpg", frame_bgr)
        if not ok:
            raise ValueError("Falha ao codificar frame para envio ao Roboflow.")
        # A API de inferência hospedada do Roboflow espera o corpo como uma
        # string base64 do JPEG (não os bytes crus da imagem) com
        # Content-Type application/x-www-form-urlencoded.
        encoded_image = base64.b64encode(buffer.tobytes())

        url = (
            f"{self.settings.ROBOFLOW_INFERENCE_BASE_URL}/"
            f"{self.settings.ROBOFLOW_TROUGH_MODEL_ID}"
        )
        params = {"api_key": api_key, "confidence": 40}

        client = await self._get_client()
        try:
            response = await client.post(
                url,
                params=params,
                content=encoded_image,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            safe_msg = redact(str(exc), api_key)
            logger.error("Erro ao consultar RoboflowTroughValidator: %s", safe_msg)
            raise

        data = response.json()
        predictions = data.get("predictions", [])

        threshold = self.settings.ROBOFLOW_TROUGH_CONFIDENCE_THRESHOLD

        trough_preds = [p for p in predictions if p.get("class") == "trough"]
        end_preds = sorted(
            (p for p in predictions if p.get("class") == "trough_end"),
            key=lambda p: p.get("confidence", 0.0),
            reverse=True,
        )
        strong_ends = [p for p in end_preds if p.get("confidence", 0.0) >= threshold]

        if trough_preds and len(strong_ends) >= 2:
            # Confiança reportada é a do elo mais fraco (a segunda
            # extremidade mais confiante) — é o que realmente limita se a
            # foto está completa, não a detecção mais forte.
            limiting_confidence = float(strong_ends[1]["confidence"])

            # Geometria pra calibração de escala (ver `scale_calculator.py`).
            # As duas extremidades mais confiantes são as mesmas já usadas
            # pra decidir "cocho completo" acima — nenhuma detecção nova.
            end_points = [RoboflowTroughValidator._extrair_centro(p) for p in strong_ends[:2]]
            end_points_validos = [p for p in end_points if p is not None]
            trough_polygon = RoboflowTroughValidator._extrair_poligono(trough_preds[0])

            return TroughValidationResult(
                cocho_completo=True,
                confidence=limiting_confidence,
                trough_polygon_px=trough_polygon,
                trough_end_points_px=end_points_validos if len(end_points_validos) == 2 else None,
            )

        if not trough_preds:
            motivo = "cocho_nao_detectado (roboflow)"
        elif len(end_preds) == 0:
            motivo = "nenhuma_extremidade_detectada (roboflow)"
        elif len(strong_ends) < 2:
            motivo = (
                f"apenas_{len(strong_ends)}_extremidade(s)_acima_do_limiar "
                f"(roboflow, {len(end_preds)} detectada(s) no total)"
            )
        else:
            motivo = "cocho_incompleto (roboflow)"

        best_end_confidence = float(end_preds[0]["confidence"]) if end_preds else 0.0
        return TroughValidationResult(
            cocho_completo=False,
            confidence=best_end_confidence,
            motivo=motivo,
        )

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    @staticmethod
    def _extrair_poligono(pred: dict) -> list[tuple[float, float]] | None:
        # Formato padrão de resposta do Roboflow pra modelo de segmentação de
        # instância: cada predição tem "points": [{"x":.., "y":..}, ...]
        # descrevendo o contorno. Se algum dia o modelo virar bounding box
        # puro (sem "points"), isso simplesmente não preenche a geometria —
        # nunca quebra a validação em si, que não depende disso.
        points = pred.get("points")
        if not points:
            return None
        try:
            return [(float(p["x"]), float(p["y"])) for p in points]
        except (KeyError, TypeError, ValueError):
            return None

    @staticmethod
    def _extrair_centro(pred: dict) -> tuple[float, float] | None:
        x, y = pred.get("x"), pred.get("y")
        if x is None or y is None:
            return None
        try:
            return (float(x), float(y))
        except (TypeError, ValueError):
            return None


def get_trough_validator(settings: Settings | None = None) -> TroughValidator:
    """Factory: escolhe a implementação de validação de cocho pela configuração."""
    settings = settings or get_settings()
    if settings.TROUGH_VALIDATOR == "roboflow":
        return RoboflowTroughValidator(settings=settings)
    return MockTroughValidator(
        always_valid=settings.TROUGH_VALIDATOR_MOCK_ALWAYS_VALID,
        confidence=settings.TROUGH_VALIDATOR_MOCK_CONFIDENCE,
    )
