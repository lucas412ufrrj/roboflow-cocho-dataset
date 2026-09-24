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

try:
    import resource  # POSIX apenas (Linux/Render) — não existe no Windows.
except ImportError:  # pragma: no cover - só acontece em Windows
    resource = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)


def _peak_rss_mb() -> float:
    if resource is None:
        # Windows não tem `resource` — métrica só pra depurar memória no
        # Render (Linux); localmente no Windows não há teto de 512MB.
        return 0.0
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024

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
    video: UploadFile = File(..., description="Vídeo gravado (~8.5s) ou selecionado da galeria (7 a 10s)."),
    peso_kg: float = Form(...),
    tipo_alimento_id: str = Form(..., description="Identificador interno do tipo de alimento selecionado, gerado no aparelho."),
    tipo_alimento_nome: str = Form(..., description="Nome do tipo de alimento definido pela pessoa."),
    tipo_alimento_densidade_aparente_kg_l: float = Form(...),
    cocho_id: str = Form(..., description="Identificador interno do cocho selecionado, gerado no aparelho."),
    cocho_nome: str = Form(..., description="Nome do cocho definido pela pessoa."),
    cocho_comprimento_cm: float = Form(...),
    cocho_largura_cm: float = Form(...),
    cocho_altura_cm: float = Form(...),
    cocho_experimento: str = Form(..., description="Rótulo do experimento/ano deste cocho, separado do cocho_id."),
    observacoes: str | None = Form(default=None),
    capture_id: str | None = Form(
        default=None,
        description="UUID gerado pelo app. Se omitido, o backend gera um novo.",
    ),
    recorded_at: int | None = Form(
        default=None,
        description="Horário real de gravação do vídeo (epoch ms), quando o app conseguiu descobrir.",
    ),
    operador: str | None = Form(
        default=None,
        description="Nome de quem gravou, quando configurado no aparelho.",
    ),
    origem: str | None = Form(
        default=None,
        description="'camera' (gravado na hora) ou 'galeria'. Ausente em app antigo, tratado como 'galeria'.",
    ),
    capture_service: CaptureService = Depends(get_capture_service),
) -> CaptureResponse:
    # Ver `X-Device-Id` em `core/security.py` — UUID por instalação do app,
    # não validado (só diagnóstico), "desconhecido" numa build antiga que
    # ainda não manda o header.
    device_id = request.headers.get("X-Device-Id") or "desconhecido"

    # Log o mais cedo possível na requisição: se o processo estiver perto do
    # teto de memória do Render ANTES mesmo de ler o vídeo, isso é sinal de
    # memória se acumulando entre requisições anteriores (o processo não
    # reinicia sozinho), não de custo deste request específico.
    logger.info(
        "create_capture: entrada da rota, device_id=%s pico memória: %.1fMB", device_id, _peak_rss_mb()
    )

    try:
        form = CaptureFormInput(
            peso_kg=peso_kg,
            tipo_alimento_id=tipo_alimento_id,
            tipo_alimento_nome=tipo_alimento_nome,
            tipo_alimento_densidade_aparente_kg_l=tipo_alimento_densidade_aparente_kg_l,
            cocho_id=cocho_id,
            cocho_nome=cocho_nome,
            cocho_comprimento_cm=cocho_comprimento_cm,
            cocho_largura_cm=cocho_largura_cm,
            cocho_altura_cm=cocho_altura_cm,
            cocho_experimento=cocho_experimento,
            observacoes=observacoes,
            recorded_at=recorded_at,
            operador=operador,
            origem=origem or "galeria",
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))

    resolved_capture_id = capture_id or str(uuid.uuid4())
    # Streaming direto pro storage (ver `process_capture_from_stream` em
    # `capture_service.py`): evita materializar o vídeo inteiro (até
    # MAX_VIDEO_SIZE_MB) como um `bytes` só em memória, o que sob upload
    # concorrente de várias pessoas da equipe some rápido demais para o teto
    # de memória do Render. Substitui o antigo `await video.read()`.
    max_size_bytes = int(get_settings().MAX_VIDEO_SIZE_MB * 1024 * 1024)

    try:
        return await capture_service.process_capture_from_stream(
            capture_id=resolved_capture_id,
            video_stream=video,
            mime_type=video.content_type or "application/octet-stream",
            original_filename=video.filename or "video.mp4",
            form=form,
            max_size_bytes=max_size_bytes,
        )
    except VideoValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Falha inesperada ao processar capture_id=%s device_id=%s", resolved_capture_id, device_id
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Falha inesperada ao processar o vídeo. Tente novamente.",
        ) from exc
