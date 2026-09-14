"""
Rotas de envio em blocos (retomável) — usadas pelo app para vídeos grandes
(ver `LIMIAR_ENVIO_EM_BLOCOS_BYTES` em `mobile/src/api/client.ts`).

Fluxo: POST /api/captures/init (uma vez) -> POST
/api/captures/{capture_id}/chunks/{chunk_index} (um por bloco, na ordem) ->
POST /api/captures/{capture_id}/complete (uma vez, ao final). Depois de
montado, o vídeo passa pelo MESMO `CaptureService.process_capture` usado
pelo envio único em `captures.py` — o envio em blocos só muda como os bytes
do vídeo chegam até o backend, não o que é feito com eles depois.

O endpoint POST /api/captures de envio único continua existindo sem
alterações, para compatibilidade com qualquer versão mais antiga do app
ainda instalada em algum aparelho.
"""

from __future__ import annotations

import base64
import binascii
import logging

from fastapi import APIRouter, Depends, Form, HTTPException, Request, status

from app.api.deps import get_capture_service, get_chunked_upload_service, get_idempotency_store
from app.config import get_settings
from app.core.security import limiter, verify_backend_api_key
from app.models.schemas import (
    CaptureFormInput,
    CaptureResponse,
    ChunkAckResponse,
    ChunkedUploadInitResponse,
)
from app.services.capture_service import CaptureService
from app.services.chunked_upload_service import ChunkedUploadError, ChunkedUploadService
from app.services.idempotency import IdempotencyStore
from app.services.video_validation import VideoValidationError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/captures", tags=["captures-em-blocos"])


@router.post(
    "/init",
    response_model=ChunkedUploadInitResponse,
    dependencies=[Depends(verify_backend_api_key)],
)
@limiter.limit(lambda: get_settings().RATE_LIMIT_CAPTURES)
async def init_chunked_upload(
    request: Request,  # exigido pelo slowapi para extrair o IP do cliente
    capture_id: str = Form(..., description="UUID gerado pelo app — identifica a sessão de envio."),
    total_size: int = Form(..., description="Tamanho total do vídeo, em bytes."),
    chunk_size: int = Form(..., description="Tamanho de cada bloco, em bytes."),
    total_chunks: int = Form(..., description="Quantidade total de blocos."),
    mime_type: str = Form(...),
    original_filename: str = Form(...),
    peso_kg: float = Form(...),
    tipo_alimento: str | None = Form(default=None),
    cocho_id: str | None = Form(default=None),
    observacoes: str | None = Form(default=None),
    recorded_at: int | None = Form(default=None),
    operador: str | None = Form(default=None),
    idempotency_store: IdempotencyStore = Depends(get_idempotency_store),
    chunked_upload_service: ChunkedUploadService = Depends(get_chunked_upload_service),
) -> ChunkedUploadInitResponse:
    # Mesmo `capture_id` já processado antes (ex.: o app não recebeu a
    # resposta de /complete e está recomeçando do zero) — devolve o
    # resultado direto, sem abrir uma sessão de envio nova.
    cached = await idempotency_store.get(capture_id)
    if cached is not None:
        response = CaptureResponse.model_validate(cached)
        response.idempotente_reprocessado = True
        return ChunkedUploadInitResponse(status="already_processed", result=response)

    # Falha cedo se o vídeo declarado já estoura o limite — sem isso, o app
    # gastaria banda enviando dezenas de blocos de um vídeo que ia ser
    # rejeitado de qualquer forma só lá no /complete.
    max_size_bytes = int(get_settings().MAX_VIDEO_SIZE_MB * 1024 * 1024)
    if total_size > max_size_bytes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Vídeo excede o tamanho máximo de {get_settings().MAX_VIDEO_SIZE_MB:.0f} MB.",
        )

    try:
        form = CaptureFormInput(
            peso_kg=peso_kg,
            tipo_alimento=tipo_alimento,
            cocho_id=cocho_id,
            observacoes=observacoes,
            recorded_at=recorded_at,
            operador=operador,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))

    try:
        received_chunks = await chunked_upload_service.init_session(
            capture_id=capture_id,
            total_size=total_size,
            chunk_size=chunk_size,
            total_chunks=total_chunks,
            mime_type=mime_type,
            original_filename=original_filename,
            form=form,
        )
    except ChunkedUploadError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))

    logger.info(
        "init_chunked_upload: capture_id=%s total_chunks=%d já recebidos=%d",
        capture_id, total_chunks, len(received_chunks),
    )
    return ChunkedUploadInitResponse(status="in_progress", received_chunks=received_chunks)


@router.post(
    "/{capture_id}/chunks/{chunk_index}",
    response_model=ChunkAckResponse,
    dependencies=[Depends(verify_backend_api_key)],
)
@limiter.limit(lambda: get_settings().RATE_LIMIT_CHUNKS)
async def upload_chunk(
    request: Request,
    capture_id: str,
    chunk_index: int,
    chunked_upload_service: ChunkedUploadService = Depends(get_chunked_upload_service),
) -> ChunkAckResponse:
    # O corpo vem como texto base64 (ver comentário em `enviarBloco` no
    # `client.ts`) — mais simples e confiável em RN/Expo do que montar um
    # corpo binário parcial, ao custo de ~33% a mais de bytes na rede.
    raw_body = await request.body()
    try:
        chunk_bytes = base64.b64decode(raw_body, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Bloco em base64 inválido: {exc}",
        )

    try:
        manifest = await chunked_upload_service.save_chunk(
            capture_id=capture_id, chunk_index=chunk_index, data=chunk_bytes
        )
    except ChunkedUploadError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))

    return ChunkAckResponse(
        received_chunks_count=len(manifest["received_chunks"]),
        total_chunks=manifest["total_chunks"],
    )


@router.post(
    "/{capture_id}/complete",
    response_model=CaptureResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_backend_api_key)],
)
@limiter.limit(lambda: get_settings().RATE_LIMIT_CAPTURES)
async def complete_chunked_upload(
    request: Request,
    capture_id: str,
    idempotency_store: IdempotencyStore = Depends(get_idempotency_store),
    chunked_upload_service: ChunkedUploadService = Depends(get_chunked_upload_service),
    capture_service: CaptureService = Depends(get_capture_service),
) -> CaptureResponse:
    # Checado ANTES de tocar nos blocos: se /complete já rodou uma vez com
    # sucesso e o app só não recebeu a resposta (rede caiu bem na hora),
    # os blocos e o manifesto já podem ter sido limpos pelo `finally` lá
    # embaixo — sem esse check aqui, o reenvio de /complete falharia com
    # "sessão não encontrada" em vez de simplesmente devolver o resultado
    # de novo, do jeito que o envio único já faz.
    cached = await idempotency_store.get(capture_id)
    if cached is not None:
        response = CaptureResponse.model_validate(cached)
        response.idempotente_reprocessado = True
        return response

    try:
        video_bytes, manifest = await chunked_upload_service.load_completed_video(capture_id)
    except ChunkedUploadError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))

    form = CaptureFormInput.model_validate(manifest["form"])
    logger.info(
        "complete_chunked_upload: capture_id=%s vídeo montado (%.1fMB) a partir de %d blocos",
        capture_id, len(video_bytes) / 1024 / 1024, manifest["total_chunks"],
    )

    try:
        return await capture_service.process_capture(
            capture_id=capture_id,
            video_bytes=video_bytes,
            mime_type=manifest["mime_type"],
            original_filename=manifest["original_filename"],
            form=form,
        )
    except VideoValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Falha inesperada ao concluir envio em blocos capture_id=%s", capture_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Falha inesperada ao processar o vídeo. Tente novamente.",
        ) from exc
    finally:
        # Limpa sempre (sucesso ou falha) — os blocos já cumpriram seu papel
        # depois de montados; se der erro definitivo (ex.: vídeo inválido),
        # não adianta guardar os blocos, a pessoa vai gravar de novo.
        await chunked_upload_service.cleanup(capture_id)
