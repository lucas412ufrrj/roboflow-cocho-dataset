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

import asyncio
import logging
import uuid
from pathlib import Path

try:
    import resource  # POSIX apenas (Linux/Render) — não existe no Windows.
except ImportError:  # pragma: no cover - só acontece em Windows
    resource = None  # type: ignore[assignment]

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
from app.services.frame_extractor import encode_jpeg, iter_frames
from app.services.idempotency import IdempotencyStore
from app.services.roboflow_client import RoboflowClient, RoboflowUploadError
from app.services.split import choose_split
from app.services.trough_validator import TroughValidator
from app.services.video_validation import (
    VideoConstraints,
    VideoValidationError,
    validate_duration,
    validate_mime_type,
    validate_size,
)
from app.storage.base import AsyncReadable, StorageBackend

logger = logging.getLogger(__name__)


def _peak_rss_mb() -> float:
    """Pico de RSS do processo (em MB) desde que ele iniciou.

    `ru_maxrss` é cumulativo (não é o uso atual, é o maior já visto), o que é
    exatamente o que queremos para depurar OOM: se essa marca já vem alta
    logo no início de um request, o problema é memória se acumulando entre
    requests (o processo do Render não reinicia a cada captura); se ela só
    dispara durante o request, o problema está dentro deste processamento.
    """
    if resource is None:
        # Windows não tem `resource` — essa métrica é só pra depurar memória
        # no Render (Linux); não faz sentido travar o processo por causa
        # dela, e localmente no Windows não há teto de 512MB pra acompanhar.
        return 0.0
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def _current_rss_mb() -> float:
    """RSS atual (não o pico) do processo, em MB. Só funciona em Linux (lê
    /proc/self/status, disponível no container do Render); fora do Linux
    devolve 0.0 sem quebrar nada."""
    try:
        with open("/proc/self/status", encoding="ascii") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except (OSError, ValueError, IndexError):
        pass
    return 0.0


def _release_memory_to_os() -> None:
    """Força o alocador do glibc a devolver memória livre ao SO.

    O motivo mais comum de um processo Python+NumPy/OpenCV de vida longa ter
    o RSS crescendo request após request, mesmo sem nenhum vazamento real de
    referência, é o `malloc` do glibc reter os blocos liberados em vez de
    devolvê-los ao SO — o Python já desalocou os arrays de frame e buffers de
    JPEG, mas o processo continua "segurando" esse espaço internamente.
    `malloc_trim(0)` pede pro glibc devolver o que puder. Isso é o que evita
    que o processo vá se aproximando do teto de 512MB do Render ao longo de
    várias capturas seguidas, mesmo com cada captura individual já com
    memória de pico controlada (streaming de frames).
    """
    import gc

    gc.collect()
    try:
        import ctypes

        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        pass  # não-Linux/não-glibc: sem equivalente direto, sem problema.


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
        """Processa a partir do vídeo já inteiro em memória.

        Usado pelo envio em blocos (`chunked_uploads.py`), que já precisa
        montar o vídeo completo a partir dos pedaços antes de chegar aqui —
        nesse caminho não há ganho em evitar o `bytes` único, o vídeo já
        está montado. Para o envio único (`/api/captures`), prefira
        `process_capture_from_stream`, que nunca materializa o vídeo inteiro
        em memória de uma vez (ver docstring lá e em `save_stream`, em
        `app/storage/base.py`).
        """
        # --- Idempotência: já processamos esse capture_id antes? ---
        cached = await self.idempotency_store.get(capture_id)
        if cached is not None:
            logger.info("capture_id %s já processado — retornando resultado cacheado.", capture_id)
            response = CaptureResponse.model_validate(cached)
            response.idempotente_reprocessado = True
            return response

        raw_key = f"{capture_id}/raw_{original_filename}"
        logger.info(
            "capture %s: início, vídeo=%.1fMB (já em memória) mime=%s, pico memória do processo até agora: %.1fMB",
            capture_id, len(video_bytes) / 1024 / 1024, mime_type, _peak_rss_mb(),
        )
        await self.storage.save_bytes(raw_key, video_bytes)
        return await self._process_from_raw_key(
            capture_id=capture_id,
            raw_key=raw_key,
            video_size=len(video_bytes),
            mime_type=mime_type,
            form=form,
        )

    async def process_capture_from_stream(
        self,
        *,
        capture_id: str,
        video_stream: AsyncReadable,
        mime_type: str,
        original_filename: str,
        form: CaptureFormInput,
        max_size_bytes: int,
    ) -> CaptureResponse:
        """Processa a partir de um stream (o `UploadFile` do FastAPI),
        gravando direto no storage conforme os bytes chegam, sem nunca
        montar o vídeo inteiro como um único objeto `bytes` em memória.

        É o caminho usado pelo envio único (`/api/captures`). Existe
        separado de `process_capture` porque ali (envio em blocos) o vídeo
        já chega pronto em memória de qualquer forma — evitar essa
        materialização lá seria trabalho sem ganho nenhum. Aqui é onde o
        ganho de memória sob upload concorrente realmente importa: sem
        isso, N pessoas da equipe enviando vídeo grande ao mesmo tempo somam
        N vídeos inteiros na RAM do processo, o que já bateu no teto de
        memória do Render antes por outros motivos (ver comentários em
        `needs_normalization`, em `ffmpeg_utils.py`).

        Levanta `VideoValidationError` se o stream ultrapassar
        `max_size_bytes` — a gravação em disco é abortada assim que o limite
        é excedido, sem terminar de gravar (e sem manter em memória) um
        arquivo que ia ser rejeitado de qualquer forma.
        """
        # --- Idempotência: já processamos esse capture_id antes? ---
        cached = await self.idempotency_store.get(capture_id)
        if cached is not None:
            logger.info("capture_id %s já processado — retornando resultado cacheado.", capture_id)
            response = CaptureResponse.model_validate(cached)
            response.idempotente_reprocessado = True
            return response

        raw_key = f"{capture_id}/raw_{original_filename}"
        logger.info(
            "capture %s: início (streaming direto pro storage), mime=%s, pico memória do processo até agora: %.1fMB",
            capture_id, mime_type, _peak_rss_mb(),
        )
        try:
            video_size = await self.storage.save_stream(
                raw_key, video_stream, max_size_bytes=max_size_bytes
            )
        except ValueError as exc:
            raise VideoValidationError(str(exc)) from exc

        logger.info(
            "capture %s: vídeo recebido via streaming (%.1fMB), pico memória: %.1fMB",
            capture_id, video_size / 1024 / 1024, _peak_rss_mb(),
        )
        return await self._process_from_raw_key(
            capture_id=capture_id,
            raw_key=raw_key,
            video_size=video_size,
            mime_type=mime_type,
            form=form,
        )

    async def _process_from_raw_key(
        self,
        *,
        capture_id: str,
        raw_key: str,
        video_size: int,
        mime_type: str,
        form: CaptureFormInput,
    ) -> CaptureResponse:
        """Núcleo do pipeline, comum aos dois pontos de entrada acima: o
        vídeo já está salvo em `raw_key` no storage (como bytes ou via
        streaming), faltando validar, normalizar, extrair frames e enviar ao
        Roboflow. Idêntico ao corpo original de `process_capture`, só
        parametrizado por `video_size` em vez de receber os bytes direto."""
        constraints = VideoConstraints.from_settings(self.settings)
        video_id = str(uuid.uuid4())
        normalized_key = f"{capture_id}/normalized.mp4"

        try:
            # --- 1. Validações estruturais ---
            validate_mime_type(mime_type, constraints)
            validate_size(video_size, constraints)

            raw_local_path = await self.storage.local_path(raw_key)

            probe = await probe_video(raw_local_path)
            validate_duration(probe, constraints)
            logger.info(
                "capture %s: probe codec=%s %dx%d fps=%.1f duracao=%.1fs, pico memória: %.1fMB",
                capture_id, probe.codec_name, probe.width, probe.height, probe.fps,
                probe.duration_s, _peak_rss_mb(),
            )

            # --- 2. Normalização (se necessário) ---
            if needs_normalization(probe, mime_type):
                logger.info(
                    "capture %s: normalização NECESSÁRIA (mime=%s codec=%s) — rodando ffmpeg",
                    capture_id, mime_type, probe.codec_name,
                )
                normalized_local_path = await self.storage.local_path(normalized_key)
                await normalize_to_h264_mp4(raw_local_path, normalized_local_path)
                processing_path = normalized_local_path
                logger.info(
                    "capture %s: normalização concluída, pico memória: %.1fMB",
                    capture_id, _peak_rss_mb(),
                )
            else:
                processing_path = raw_local_path
                logger.info("capture %s: normalização pulada (já é mp4/h264)", capture_id)

            # --- 3. Extração de frames (streaming) ---
            # `iter_frames` decodifica e entrega um frame por vez (a
            # decodificação roda em thread separada, com uma fila de tamanho
            # 2 fazendo backpressure), em vez de decodificar o vídeo inteiro
            # e manter todos os frames aceitos em memória simultaneamente.
            # O processamento continua sequencial, frame a frame, como
            # antes — só muda como os frames chegam.
            split = choose_split(video_id)

            frame_results: list[FrameResult] = []
            aprovados = desfocados = cocho_incompleto = falhas_upload = 0
            total_candidatos = 0

            async for frame in iter_frames(processing_path, self.settings.FRAMES_PER_SECOND):
                total_candidatos += 1
                if total_candidatos == 1 or total_candidatos % 5 == 0:
                    logger.info(
                        "capture %s: frame candidato #%d, pico memória: %.1fMB",
                        capture_id, total_candidatos, _peak_rss_mb(),
                    )
                # `compute_focus_score`/`encode_jpeg` (mais abaixo) são
                # CPU-bound e síncronos (OpenCV). Chamá-los direto aqui
                # travaria o único event loop do processo durante o
                # cálculo, impedindo QUALQUER outra requisição (inclusive
                # `/health` e o upload de outra pessoa da equipe) de
                # avançar nesse meio-tempo. `asyncio.to_thread` tira esse
                # trabalho do event loop, permitindo uploads concorrentes
                # intercalarem de verdade em vez de serializar o processo
                # inteiro a cada frame.
                focus_score = await asyncio.to_thread(compute_focus_score, frame.frame_bgr)

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
                    recorded_at=form.recorded_at,
                    operador=form.operador,
                )

                image_bytes = await asyncio.to_thread(encode_jpeg, frame.frame_bgr)
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
                total_candidatos=total_candidatos,
                total_aprovados=aprovados,
                total_rejeitados_desfoque=desfocados,
                total_rejeitados_cocho_incompleto=cocho_incompleto,
                total_falhas_upload=falhas_upload,
                frames=frame_results,
            )

            await self.idempotency_store.set(capture_id, response.model_dump(mode="json"))
            logger.info(
                "capture %s: concluído (%d candidatos, %d aprovados), pico memória: %.1fMB",
                capture_id, total_candidatos, aprovados, _peak_rss_mb(),
            )
            return response

        finally:
            # --- 8. Limpeza de arquivos temporários (sucesso OU falha) ---
            await self._cleanup(raw_key, normalized_key)
            rss_antes = _current_rss_mb()
            _release_memory_to_os()
            rss_depois = _current_rss_mb()
            logger.info(
                "capture %s: memória devolvida ao SO: %.1fMB -> %.1fMB (liberados %.1fMB)",
                capture_id, rss_antes, rss_depois, rss_antes - rss_depois,
            )

    async def _cleanup(self, *keys: str) -> None:
        for key in keys:
            try:
                if await self.storage.exists(key):
                    await self.storage.delete(key)
            except Exception:  # noqa: BLE001
                logger.warning("Falha ao remover arquivo temporário %s", key, exc_info=True)
