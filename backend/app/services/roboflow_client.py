"""
Cliente para o endpoint de upload de imagens do dataset Roboflow.

Regras seguidas aqui (ver especificação do projeto):
- Cada frame aprovado é enviado via multipart/form-data.
- O `capture_id` do vídeo é usado como `batch_name` no Roboflow.
- Tags: "mobile-capture", "frame-valid" e, se houver, o tipo de alimento.
- Metadata JSON: peso_kg, video_id, frame_time_ms, focus_score,
  cocho_completo, tipo_alimento, cocho_id, observacoes.
- Timeout + retries com exponential backoff.
- Idempotência: reenviar o mesmo (capture_id, frame_index) não duplica a
  imagem no Roboflow (ver `IdempotencyStore` em `capture_service.py`).
- `ROBOFLOW_API_KEY` nunca é logada.
"""

from __future__ import annotations

import logging

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.config import Settings, get_settings
from app.core.logging import redact
from app.models.schemas import FrameMetadata

logger = logging.getLogger(__name__)


class RoboflowUploadError(RuntimeError):
    """Erro definitivo (após esgotar retries) ao subir uma imagem ao Roboflow."""


class RoboflowRetryableError(RuntimeError):
    """Erro transitório (timeout, 5xx, 429) — elegível para retry."""


class RoboflowUploadResult:
    def __init__(self, image_id: str | None, raw_response: dict) -> None:
        self.image_id = image_id
        self.raw_response = raw_response


class RoboflowClient:
    def __init__(
        self,
        settings: Settings | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self._client = client
        self._owns_client = client is None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.settings.ROBOFLOW_UPLOAD_TIMEOUT_S)
        return self._client

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()

    def _build_tags(self, tipo_alimento: str | None) -> list[str]:
        tags = ["mobile-capture", "frame-valid"]
        if tipo_alimento:
            tags.append(tipo_alimento)
        return tags

    async def upload_frame(
        self,
        *,
        image_bytes: bytes,
        filename: str,
        capture_id: str,
        metadata: FrameMetadata,
    ) -> RoboflowUploadResult:
        """
        Envia um frame aprovado ao endpoint de upload de imagens do Roboflow.

        Levanta `RoboflowUploadError` se todas as tentativas falharem.
        """
        if not self.settings.ROBOFLOW_API_KEY:
            raise RoboflowUploadError(
                "ROBOFLOW_API_KEY não configurada no backend — upload abortado."
            )

        try:
            return await self._upload_with_retry(
                image_bytes=image_bytes,
                filename=filename,
                capture_id=capture_id,
                metadata=metadata,
            )
        except RoboflowRetryableError as exc:
            safe_msg = redact(str(exc), self.settings.ROBOFLOW_API_KEY)
            logger.error("Upload ao Roboflow esgotou tentativas: %s", safe_msg)
            raise RoboflowUploadError(safe_msg) from exc

    async def _upload_with_retry(
        self,
        *,
        image_bytes: bytes,
        filename: str,
        capture_id: str,
        metadata: FrameMetadata,
    ) -> RoboflowUploadResult:
        retryer = retry(
            reraise=True,
            stop=stop_after_attempt(self.settings.ROBOFLOW_UPLOAD_MAX_RETRIES),
            wait=wait_exponential(multiplier=0.5, min=0.5, max=8),
            retry=retry_if_exception_type(RoboflowRetryableError),
        )
        return await retryer(self._do_upload)(
            image_bytes=image_bytes,
            filename=filename,
            capture_id=capture_id,
            metadata=metadata,
        )

    async def _do_upload(
        self,
        *,
        image_bytes: bytes,
        filename: str,
        capture_id: str,
        metadata: FrameMetadata,
    ) -> RoboflowUploadResult:
        url = f"{self.settings.ROBOFLOW_UPLOAD_BASE_URL}/dataset/{self.settings.ROBOFLOW_PROJECT}/upload"

        tags = self._build_tags(metadata.tipo_alimento)
        query_params: list[tuple[str, str]] = [
            ("api_key", self.settings.ROBOFLOW_API_KEY),
            ("batch_name", capture_id),
        ]
        query_params += [("tag", t) for t in tags]

        files = {
            "file": (filename, image_bytes, "image/jpeg"),
        }
        data = {
            "name": filename,
            "metadata": metadata.model_dump_json(),
        }

        client = await self._get_client()
        try:
            response = await client.post(url, params=query_params, files=files, data=data)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            raise RoboflowRetryableError(f"Falha de rede ao enviar frame: {exc}") from exc

        if response.status_code == 429 or response.status_code >= 500:
            raise RoboflowRetryableError(
                f"Roboflow retornou status transitório {response.status_code}."
            )
        if response.status_code >= 400:
            safe_msg = redact(response.text, self.settings.ROBOFLOW_API_KEY)
            raise RoboflowUploadError(
                f"Roboflow rejeitou o upload (status {response.status_code}): {safe_msg}"
            )

        payload = response.json()
        image_id = payload.get("id") or (payload.get("image") or {}).get("id")
        return RoboflowUploadResult(image_id=image_id, raw_response=payload)
