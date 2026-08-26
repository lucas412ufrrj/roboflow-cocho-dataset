"""Rota principal: recebe o vídeo do app móvel e dispara o pipeline de captura."""

import logging
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status

from app.api.deps import get_capture_service
from app.config import get_settings
from app.core.security import limiter, verify_backend_api_key
from app.models.schemas import CaptureFormInput, CaptureResponse
from app.services.capture_service import CaptureService
from app.services.video_validation import VideoValidationError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["captures"])


@router.post(
    "/captures",
    response_model=CaptureResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_backend_api_key)],
)
@limiter.limit(lambda: get_settings().RATE_LIMIT_CAPTURES)
async def create_capture(
    request: Request,  # exigido pelo slowapi para extrair o IP do cliente
    video: UploadFile = File(..., description="Arquivo de vídeo MP4 (7 a 10s)."),
    peso_kg: float = Form(...),
    tipo_alimento: str | None = Form(default=None),
    cocho_id: str | None = Form(default=None),
    observacoes: str | None = Form(default=None),
    capture_id: str | None = Form(
        default=None,
        description="UUID gerado pelo app. Se omitido, o backend gera um novo.",
    ),
    capture_service: CaptureService = Depends(get_capture_service),
) -> CaptureResponse:
    try:
        form = CaptureFormInput(
            peso_kg=peso_kg,
            tipo_alimento=tipo_alimento,
            cocho_id=cocho_id,
            observacoes=observacoes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))

    resolved_capture_id = capture_id or str(uuid.uuid4())
    video_bytes = await video.read()

    try:
        return await capture_service.process_capture(
            capture_id=resolved_capture_id,
            video_bytes=video_bytes,
            mime_type=video.content_type or "application/octet-stream",
            original_filename=video.filename or "video.mp4",
            form=form,
        )
    except VideoValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Falha inesperada ao processar capture_id=%s", resolved_capture_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Falha inesperada ao processar o vídeo. Tente novamente.",
        ) from exc
