"""
Cliente para o endpoint de upload de imagens de dataset do Roboflow.

`upload_frame` é o caminho principal — dataset de peso (`ROBOFLOW_PROJECT`):
- Cada frame aprovado é enviado via multipart/form-data.
- O `capture_id` do vídeo é usado como `batch_name` no Roboflow.
- Tags: "mobile-capture", "frame-valid", se houver o tipo de alimento, e
  "experimento-<rótulo>" (ver CaptureFormInput.cocho_experimento) — permite
  filtrar/comparar imagens por experimento direto na interface do Roboflow.
- Metadata JSON: peso_kg, video_id, frame_time_ms, focus_score,
  cocho_completo, tipo_alimento, cocho_id, observacoes.
- Timeout + retries com exponential backoff.
- Idempotência: reenviar o mesmo (capture_id, frame_index) não duplica a
  imagem no Roboflow (ver `IdempotencyStore` em `capture_service.py`).
- `ROBOFLOW_API_KEY` nunca é logada.

`upload_frame_to_project` é um caminho secundário, genérico, que reaproveita
a mesma lógica de upload/retry pra mandar imagem a QUALQUER projeto/chave
Roboflow — usado por `capture_service.py` para reenviar frames de "cocho
incompleto" ao dataset do Modelo 1 (ver `Settings.ENVIAR_COCHO_INCOMPLETO_MODELO_1`
em `config.py`), sem o schema de `FrameMetadata` (que é específico do
Modelo 2/peso).
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

    def _build_tags(self, tipo_alimento: str | None, cocho_experimento: str) -> list[str]:
        tags = ["mobile-capture", "frame-valid"]
        if tipo_alimento:
            tags.append(tipo_alimento)
        if cocho_experimento:
            # Prefixo pra não colidir/confundir com a tag livre de tipo_alimento
            # acima, e pra ficar claro no Roboflow que essa tag identifica um
            # experimento/ano, não um tipo de alimento.
            tags.append(f"experimento-{cocho_experimento}")
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
        Envia um frame aprovado ao dataset de peso (`ROBOFLOW_PROJECT`).

        Levanta `RoboflowUploadError` se todas as tentativas falharem.
        """
        if not self.settings.ROBOFLOW_API_KEY:
            raise RoboflowUploadError(
                "ROBOFLOW_API_KEY não configurada no backend — upload abortado."
            )

        tags = self._build_tags(metadata.tipo_alimento, metadata.cocho_experimento)
        return await self._upload_ou_relanca(
            image_bytes=image_bytes,
            filename=filename,
            capture_id=capture_id,
            project=self.settings.ROBOFLOW_PROJECT,
            api_key=self.settings.ROBOFLOW_API_KEY,
            tags=tags,
            metadata_json=metadata.model_dump_json(),
        )

    async def upload_frame_to_project(
        self,
        *,
        image_bytes: bytes,
        filename: str,
        capture_id: str,
        project: str,
        api_key: str,
        tags: list[str],
    ) -> RoboflowUploadResult:
        """
        Envia uma imagem a um projeto/dataset Roboflow arbitrário — usado
        hoje só para mandar frames reprovados por "cocho incompleto" ao
        dataset do Modelo 1 (`reconhecimento-de-cocho`), que pode viver num
        workspace/chave diferente do dataset de peso usado por
        `upload_frame` acima. Sem `metadata` (esse dataset não tem o schema
        de `FrameMetadata` — é imagem crua esperando anotação manual). Mesma
        lógica de retry/erro de `upload_frame`.

        Levanta `RoboflowUploadError` se todas as tentativas falharem ou se
        `api_key` vier vazia.
        """
        if not api_key:
            raise RoboflowUploadError(
                f"Nenhuma chave configurada para upload no projeto '{project}'."
            )
        return await self._upload_ou_relanca(
            image_bytes=image_bytes,
            filename=filename,
            capture_id=capture_id,
            project=project,
            api_key=api_key,
            tags=tags,
            metadata_json=None,
        )

    async def _upload_ou_relanca(
        self,
        *,
        image_bytes: bytes,
        filename: str,
        capture_id: str,
        project: str,
        api_key: str,
        tags: list[str],
        metadata_json: str | None,
    ) -> RoboflowUploadResult:
        """Roda `_upload_with_retry` e converte um erro transitório esgotado
        em `RoboflowUploadError` (definitivo) — comum a `upload_frame` e
        `upload_frame_to_project`."""
        try:
            return await self._upload_with_retry(
                image_bytes=image_bytes,
                filename=filename,
                capture_id=capture_id,
                project=project,
                api_key=api_key,
                tags=tags,
                metadata_json=metadata_json,
            )
        except RoboflowRetryableError as exc:
            safe_msg = redact(str(exc), api_key)
            logger.error(
                "Upload ao Roboflow (projeto %s) esgotou tentativas: %s", project, safe_msg
            )
            raise RoboflowUploadError(safe_msg) from exc

    async def _upload_with_retry(
        self,
        *,
        image_bytes: bytes,
        filename: str,
        capture_id: str,
        project: str,
        api_key: str,
        tags: list[str],
        metadata_json: str | None,
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
            project=project,
            api_key=api_key,
            tags=tags,
            metadata_json=metadata_json,
        )

    async def _do_upload(
        self,
        *,
        image_bytes: bytes,
        filename: str,
        capture_id: str,
        project: str,
        api_key: str,
        tags: list[str],
        metadata_json: str | None,
    ) -> RoboflowUploadResult:
        url = f"{self.settings.ROBOFLOW_UPLOAD_BASE_URL}/dataset/{project}/upload"

        query_params: list[tuple[str, str]] = [
            ("api_key", api_key),
            ("batch_name", capture_id),
        ]
        query_params += [("tag", t) for t in tags]

        files = {
            "file": (filename, image_bytes, "image/jpeg"),
        }
        data = {"name": filename}
        if metadata_json is not None:
            data["metadata"] = metadata_json

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
            safe_msg = redact(response.text, api_key)
            raise RoboflowUploadError(
                f"Roboflow rejeitou o upload (status {response.status_code}): {safe_msg}"
            )

        payload = response.json()
        image_id = payload.get("id") or (payload.get("image") or {}).get("id")
        return RoboflowUploadResult(image_id=image_id, raw_response=payload)
