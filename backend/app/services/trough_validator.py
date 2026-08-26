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
    Implementação real, preparada para chamar um Model/Workflow do Roboflow
    especializado em detectar se o cocho está inteiro/visível no frame.

    A chave `ROBOFLOW_API_KEY` é lida da configuração do backend e NUNCA é
    logada nem retornada ao cliente. Use `ROBOFLOW_TROUGH_MODEL_ID` (ex.:
    "workspace/cocho-integrity/1") para apontar o modelo/workflow treinado.
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
        if not self.settings.ROBOFLOW_API_KEY:
            raise RuntimeError("ROBOFLOW_API_KEY não configurada no backend.")

        import cv2

        ok, buffer = cv2.imencode(".jpg", frame_bgr)
        if not ok:
            raise ValueError("Falha ao codificar frame para envio ao Roboflow.")

        url = (
            f"{self.settings.ROBOFLOW_UPLOAD_BASE_URL}/"
            f"{self.settings.ROBOFLOW_TROUGH_MODEL_ID}"
        )
        params = {"api_key": self.settings.ROBOFLOW_API_KEY, "confidence": 40}

        client = await self._get_client()
        try:
            response = await client.post(
                url,
                params=params,
                content=buffer.tobytes(),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            safe_msg = redact(str(exc), self.settings.ROBOFLOW_API_KEY)
            logger.error("Erro ao consultar RoboflowTroughValidator: %s", safe_msg)
            raise

        data = response.json()
        predictions = data.get("predictions", [])
        # Regra de decisão de exemplo: considera "cocho completo" se existir ao
        # menos uma predição da classe "cocho_completo" (ou similar) acima do
        # limiar configurado. Ajuste conforme o modelo real treinado.
        threshold = self.settings.ROBOFLOW_TROUGH_CONFIDENCE_THRESHOLD
        best = max(
            (p for p in predictions if p.get("class") in ("cocho_completo", "trough_complete")),
            key=lambda p: p.get("confidence", 0.0),
            default=None,
        )
        if best is not None and best.get("confidence", 0.0) >= threshold:
            return TroughValidationResult(
                cocho_completo=True, confidence=float(best["confidence"])
            )
        return TroughValidationResult(
            cocho_completo=False,
            confidence=float(best["confidence"]) if best else 0.0,
            motivo="cocho_incompleto (roboflow)",
        )

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()


def get_trough_validator(settings: Settings | None = None) -> TroughValidator:
    """Factory: escolhe a implementação de validação de cocho pela configuração."""
    settings = settings or get_settings()
    if settings.TROUGH_VALIDATOR == "roboflow":
        return RoboflowTroughValidator(settings=settings)
    return MockTroughValidator(
        always_valid=settings.TROUGH_VALIDATOR_MOCK_ALWAYS_VALID,
        confidence=settings.TROUGH_VALIDATOR_MOCK_CONFIDENCE,
    )
