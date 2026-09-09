"""
Orquestra o pipeline completo de uma captura de vídeo:

1. Valida MIME/tamanho/duração/peso (feito antes, na camada de API).
2. Normaliza o vídeo para MP4/H.264 quando necessário.
3. Extrai frames a `FRAMES_PER_SECOND`.
4. Calcula focus_score (variância do Laplaciano) e rejeita abaixo do limiar.
5. Valida "cocho completo" via `TroughValidator` (mock ou Roboflow).
6. Envia frames aprovados ao Roboflow com metadata e tags.
7. Garante idempotência por `capture_id`.
8. Sempre limpa arquivos temporários (sucesso ou falha).
9. Retorna as contagens exigidas pela especificação.
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

from app.config import Settings, get_settings
from app.models.schemas import (
    CaptureFormInput,
    CaptureResponse,
    FrameMetadata,
    FrameResult,
    FrameStatus,
)
from app.services.ffmpeg_utils import normalize_to_h264_mp4, needs_normalization, probe_video
from app.services.focus import compute_focus_score, is_frame_sharp
from app.services.frame_extractor import encode_jpeg, extract_frames
from app.services.idempotency import IdempotencyStore
from app.services.roboflow_client import RoboflowClient, RoboflowUploadError
from app.services.split import choose_split
from app.services.trough_validator import TroughValidator
from app.services.video_validation import (
    VideoConstraints,
    validate_duration,
    validate_mime_type,
    validate_size,
)
from app.storage.base import StorageBackend

logger = logging.getLogger(__name__)


class CaptureService:
    def __init__(
        self,
        storage: StorageBackend,
        trough_validator: TroughValidator,
        roboflow_client: RoboflowClient,
        idempotency_store: IdempotencyStore,
        settings: Settings | None = None,
    ) -> None:
        self.storage = storage
        self.trough_validator = trough_validator
        self.roboflow_client = roboflow_client
        self.idempotency_store = idempotency_store
        self.settings = settings or get_settings()

    async def process_capture(
        self,
        *,
        capture_id: str,
        video_bytes: bytes,
        mime_type: str,
        original_filename: str,
        form: CaptureFormInput,
    ) -> CaptureResponse:
        # --- Idempotência: já processamos esse capture_id antes? ---
        cached = await self.idempotency_store.get(capture_id)
        if cached is not None:
            logger.info("capture_id %s já processado — retornando resultado cacheado.", capture_id)
            response = CaptureResponse.model_validate(cached)
            response.idempotente_reprocessado = True
            return response

        constraints = VideoConstraints.from_settings(self.settings)
        video_id = str(uuid.uuid4())

        raw_key = f"{capture_id}/raw_{original_filename}"
        normalized_key = f"{capture_id}/normalized.mp4"

        try:
            # --- 1. Validações estruturais ---
            validate_mime_type(mime_type, constraints)
            validate_size(len(video_bytes), constraints)

            await self.storage.save_bytes(raw_key, video_bytes)
            raw_local_path = await self.storage.local_path(raw_key)

            probe = await probe_video(raw_local_path)
            validate_duration(probe, constraints)

            # --- 2. Normalização (se necessário) ---
            if needs_normalization(probe, mime_type):
                normalized_local_path = await self.storage.local_path(normalized_key)
                await normalize_to_h264_mp4(raw_local_path, normalized_local_path)
                processing_path = normalized_local_path
            else:
                processing_path = raw_local_path

            # --- 3. Extração de frames ---
            frames = await extract_frames(processing_path, self.settings.FRAMES_PER_SECOND)

            split = choose_split(video_id)

            frame_results: list[FrameResult] = []
            aprovados = desfocados = cocho_incompleto = falhas_upload = 0

            for frame in frames:
                focus_score = compute_focus_score(frame.frame_bgr)

                if not is_frame_sharp(focus_score, self.settings.FOCUS_SCORE_THRESHOLD):
                    desfocados += 1
                    frame_results.append(
                        FrameResult(
                            frame_index=frame.index,
                            frame_time_ms=frame.time_ms,
                            focus_score=focus_score,
                            cocho_completo=False,
                            status=FrameStatus.rejeitado_desfoque,
                            motivo_rejeicao="focus_score abaixo do limiar configurado",
                        )
                    )
                    continue

                trough_result = await self.trough_validator.validate(frame.frame_bgr)
                if not trough_result.cocho_completo:
                    cocho_incompleto += 1
                    frame_results.append(
                        FrameResult(
                            frame_index=frame.index,
                            frame_time_ms=frame.time_ms,
                            focus_score=focus_score,
                            cocho_completo=False,
                            status=FrameStatus.rejeitado_cocho_incompleto,
                            motivo_rejeicao=trough_result.motivo or "cocho incompleto",
                        )
                    )
                    continue

                metadata = FrameMetadata(
                    peso_kg=form.peso_kg,
                    video_id=video_id,
                    frame_time_ms=frame.time_ms,
                    focus_score=focus_score,
                    cocho_completo=True,
                    tipo_alimento=form.tipo_alimento,
                    cocho_id=form.cocho_id,
                    observacoes=form.observacoes,
                )

                image_bytes = encode_jpeg(frame.frame_bgr)
                filename = f"{video_id}_{frame.index:03d}.jpg"

                try:
                    upload_result = await self.roboflow_client.upload_frame(
                        image_bytes=image_bytes,
                        filename=filename,
                        capture_id=capture_id,
                        metadata=metadata,
                    )
                    aprovados += 1
                    frame_results.append(
                        FrameResult(
                            frame_index=frame.index,
                            frame_time_ms=frame.time_ms,
                            focus_score=focus_score,
                            cocho_completo=True,
                            status=FrameStatus.aprovado,
                            roboflow_image_id=upload_result.image_id,
                        )
                    )
                except RoboflowUploadError as exc:
                    falhas_upload += 1
                    frame_results.append(
                        FrameResult(
                            frame_index=frame.index,
                            frame_time_ms=frame.time_ms,
                            focus_score=focus_score,
                            cocho_completo=True,
                            status=FrameStatus.falha_upload,
                            motivo_rejeicao=str(exc),
                        )
                    )

            response = CaptureResponse(
                capture_id=capture_id,
                video_id=video_id,
                split=split,
                peso_kg=form.peso_kg,
                total_candidatos=len(frames),
                total_aprovados=aprovados,
                total_rejeitados_desfoque=desfocados,
                total_rejeitados_cocho_incompleto=cocho_incompleto,
                total_falhas_upload=falhas_upload,
                frames=frame_results,
            )

            await self.idempotency_store.set(capture_id, response.model_dump(mode="json"))
            return response

        finally:
            # --- 8. Limpeza de arquivos temporários (sucesso OU falha) ---
            await self._cleanup(raw_key, normalized_key)

    async def _cleanup(self, *keys: str) -> None:
        for key in keys:
            try:
                if await self.storage.exists(key):
                    await self.storage.delete(key)
            except Exception:  # noqa: BLE001
                logger.warning("Falha ao remover arquivo temporário %s", key, exc_info=True)
