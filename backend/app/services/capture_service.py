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
import re
import uuid
from pathlib import Path

import numpy as np

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
from app.services.ffmpeg_utils import (
    needs_normalization,
    normalize_to_h264_mp4,
    probe_video,
    reencode_for_camera_origin,
)
from app.services.focus import compute_focus_score, is_frame_sharp
from app.services.frame_extractor import encode_jpeg, iter_frames
from app.services.idempotency import IdempotencyStore
from app.services.roboflow_client import RoboflowClient, RoboflowUploadError
from app.services.scale_calculator import area_poligono_cm2, escala_cm_por_pixel
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


def _slug_motivo_incompleto(motivo: str) -> str:
    """Reduz um `motivo` de `TroughValidationResult` (ex.:
    "apenas_1_extremidade(s)_acima_do_limiar (roboflow, 2 detectada(s) no
    total)") a uma tag curta pro Roboflow (ex.: "apenas-1-extremidade-s-
    acima-do-limiar"), descartando o detalhe entre parênteses. Só afeta a
    tag usada no envio ao Modelo 1 (ver `_enviar_frame_incompleto_modelo1`);
    o `motivo` completo continua indo no `FrameResult` devolvido ao app."""
    base = motivo.split(" (", 1)[0].strip()
    slug = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-")
    return slug or "cocho-incompleto"


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

        NENHUMA rota usa este caminho hoje, de propósito: ele materializa o
        vídeo inteiro como um único `bytes`, e é exatamente isso que estourou
        o teto de 512MB do Render em 22/09 (o envio em blocos montava o vídeo
        na RAM antes de chamar aqui). Tanto o envio único (`/api/captures`)
        quanto o envio em blocos (`/api/captures/{id}/complete`) usam
        `process_capture_from_stream`, que grava direto no storage conforme
        lê, sem nunca ter o vídeo inteiro em memória (ver docstring lá, em
        `save_stream` em `app/storage/base.py`, e em
        `ChunkedUploadService.abrir_video_montado`).

        Continua existindo porque é o caminho mais simples de exercitar em
        teste (vídeo pequeno, já em memória) e é usado assim por
        `tests/test_idempotency.py` e `tests/test_capture_service_modelo1.py`.
        Para qualquer código de produção, prefira o caminho por streaming.
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
            validate_duration(probe, constraints, origem=form.origem)
            logger.info(
                "capture %s: probe origem=%s codec=%s %dx%d fps=%.1f duracao=%.1fs, pico memória: %.1fMB",
                capture_id, form.origem, probe.codec_name, probe.width, probe.height, probe.fps,
                probe.duration_s, _peak_rss_mb(),
            )

            # --- 2. Normalização (se necessário) ---
            if form.origem == "camera":
                # Vídeo de câmera SEMPRE reencoda, independente do codec de
                # origem — ver docstring de `reencode_for_camera_origin`. Não
                # dá pra confiar que a câmera customizada do app já entrega
                # um arquivo em tamanho razoável, diferente da câmera nativa
                # do sistema (usada para vídeo de galeria).
                logger.info(
                    "capture %s: origem=camera — reencode incondicional (resolução/bitrate)",
                    capture_id,
                )
                normalized_local_path = await self.storage.local_path(normalized_key)
                await reencode_for_camera_origin(raw_local_path, normalized_local_path)
                processing_path = normalized_local_path
                logger.info(
                    "capture %s: reencode de câmera concluído, pico memória: %.1fMB",
                    capture_id, _peak_rss_mb(),
                )
            elif needs_normalization(probe, mime_type):
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
            # Acumulador que decide, frame incompleto a frame incompleto, se
            # ESTE vai pro Modelo 1 — ver
            # `Settings.ROBOFLOW_TROUGH_FRACAO_FRAMES_INCOMPLETOS`. Soma a
            # fração configurada a cada frame incompleto e dispara o envio
            # sempre que passa de 1.0 (subtraindo 1.0 na hora), o que
            # distribui a fração escolhida de forma uniforme ao longo do
            # vídeo em vez de só pegar os primeiros N — com 0.5 (padrão),
            # isso manda o 2º, 4º, 6º... frame incompleto.
            frames_incompletos_acumulador = 0.0

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
                    motivo = trough_result.motivo or "cocho incompleto"
                    frame_results.append(
                        FrameResult(
                            frame_index=frame.index,
                            frame_time_ms=frame.time_ms,
                            focus_score=focus_score,
                            cocho_completo=False,
                            status=FrameStatus.rejeitado_cocho_incompleto,
                            motivo_rejeicao=motivo,
                        )
                    )
                    if self.settings.ENVIAR_COCHO_INCOMPLETO_MODELO_1:
                        frames_incompletos_acumulador += (
                            self.settings.ROBOFLOW_TROUGH_FRACAO_FRAMES_INCOMPLETOS
                        )
                    if frames_incompletos_acumulador >= 1.0:
                        frames_incompletos_acumulador -= 1.0
                        await self._enviar_frame_incompleto_modelo1(
                            frame_bgr=frame.frame_bgr,
                            video_id=video_id,
                            frame_index=frame.index,
                            capture_id=capture_id,
                            motivo=motivo,
                            cocho_experimento=form.cocho_experimento,
                        )
                    continue

                # Escala (cm por pixel) e área do próprio cocho, calculadas a
                # partir da geometria que o modelo 1 já detectou pra validar
                # "cocho completo" acima — nenhuma chamada extra ao Roboflow.
                # Isso ainda não mede o alimento (esse modelo não existe
                # ainda), mas já deixa a conta pronta e testada com dados
                # reais: quando o modelo do alimento existir, a mesma
                # `area_poligono_cm2` é reaproveitada, só trocando o polígono
                # do cocho pelo do alimento.
                escala = None
                area_cocho_cm2 = None
                if trough_result.trough_end_points_px is not None:
                    escala = escala_cm_por_pixel(
                        trough_result.trough_end_points_px[0],
                        trough_result.trough_end_points_px[1],
                        comprimento_real_cm=form.cocho_comprimento_cm,
                    )
                if escala is not None and trough_result.trough_polygon_px is not None:
                    area_cocho_cm2 = area_poligono_cm2(trough_result.trough_polygon_px, escala)

                metadata = FrameMetadata(
                    peso_kg=form.peso_kg,
                    video_id=video_id,
                    frame_time_ms=frame.time_ms,
                    focus_score=focus_score,
                    cocho_completo=True,
                    tipo_alimento=form.tipo_alimento_nome,
                    tipo_alimento_densidade_aparente_kg_l=form.tipo_alimento_densidade_aparente_kg_l,
                    cocho_id=form.cocho_id,
                    cocho_nome=form.cocho_nome,
                    cocho_comprimento_cm=form.cocho_comprimento_cm,
                    cocho_largura_cm=form.cocho_largura_cm,
                    cocho_altura_cm=form.cocho_altura_cm,
                    cocho_experimento=form.cocho_experimento,
                    escala_cm_por_pixel=escala,
                    cocho_area_cm2=area_cocho_cm2,
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

    async def _enviar_frame_incompleto_modelo1(
        self,
        *,
        frame_bgr: np.ndarray,
        video_id: str,
        frame_index: int,
        capture_id: str,
        motivo: str,
        cocho_experimento: str,
    ) -> None:
        """Envia, em melhor esforço, um frame reprovado por "cocho
        incompleto" ao dataset do Modelo 1 (`ROBOFLOW_TROUGH_UPLOAD_PROJECT`
        — ver `RoboflowClient.upload_frame_to_project` e a decisão em
        `config.Settings.ENVIAR_COCHO_INCOMPLETO_MODELO_1`). A imagem sobe
        SEM anotação, pra entrar num lote de reanotação manual futuro.

        Nunca propaga exceção: uma falha aqui (rede, chave sem permissão de
        escrita nesse projeto, etc.) é só logada como aviso — não pode
        derrubar nem marcar como falha a captura principal, que é sobre
        peso, não sobre isso.
        """
        api_key = self.settings.ROBOFLOW_TROUGH_API_KEY or self.settings.ROBOFLOW_API_KEY
        project = self.settings.ROBOFLOW_TROUGH_UPLOAD_PROJECT
        if not api_key or not project:
            logger.warning(
                "capture %s: ENVIAR_COCHO_INCOMPLETO_MODELO_1 ligado mas falta "
                "ROBOFLOW_TROUGH_API_KEY/ROBOFLOW_API_KEY ou ROBOFLOW_TROUGH_UPLOAD_PROJECT "
                "— pulando envio do frame incompleto ao Modelo 1.",
                capture_id,
            )
            return

        try:
            image_bytes = await asyncio.to_thread(encode_jpeg, frame_bgr)
            filename = f"{video_id}_{frame_index:03d}_incompleto.jpg"
            tags = ["cocho-incompleto", _slug_motivo_incompleto(motivo)]
            if cocho_experimento:
                tags.append(f"experimento-{cocho_experimento}")

            await self.roboflow_client.upload_frame_to_project(
                image_bytes=image_bytes,
                filename=filename,
                capture_id=capture_id,
                project=project,
                api_key=api_key,
                tags=tags,
            )
        except RoboflowUploadError as exc:
            logger.warning(
                "capture %s: falha ao enviar frame incompleto ao Modelo 1 "
                "(melhor esforço, não afeta a captura principal): %s",
                capture_id, exc,
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "capture %s: erro inesperado ao enviar frame incompleto ao Modelo 1 "
                "(melhor esforço, não afeta a captura principal)",
                capture_id, exc_info=True,
            )

    async def _cleanup(self, *keys: str) -> None:
        for key in keys:
            try:
                if await self.storage.exists(key):
                    await self.storage.delete(key)
            except Exception:  # noqa: BLE001
                logger.warning("Falha ao remover arquivo temporário %s", key, exc_info=True)
