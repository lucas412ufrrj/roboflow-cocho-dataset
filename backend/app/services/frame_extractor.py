"""Extração de frames de um vídeo usando OpenCV, a uma taxa configurável (fps)."""

from __future__ import annotations

import asyncio
import queue
import threading
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass(frozen=True)
class ExtractedFrame:
    index: int
    time_ms: int
    frame_bgr: np.ndarray


_SENTINEL = object()


def _produce_frames(
    path: str,
    frames_per_second: float,
    out_queue: "queue.Queue",
    stop_event: threading.Event,
) -> None:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        out_queue.put(RuntimeError(f"Não foi possível abrir o vídeo para extração: {path}"))
        return

    try:
        source_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        if source_fps <= 0:
            source_fps = 30.0
        step = max(1, round(source_fps / frames_per_second))

        frame_idx = 0
        accepted_idx = 0
        while not stop_event.is_set():
            ok, frame = cap.read()
            if not ok:
                break
            if frame_idx % step == 0:
                time_ms = int((frame_idx / source_fps) * 1000)
                # Bloqueia aqui se a fila estiver cheia — é isso que dá o
                # backpressure: a decodificação (thread) não corre à frente
                # do consumo (loop async), então nunca acumulamos mais que
                # `max_buffered` frames decodificados em memória.
                out_queue.put(ExtractedFrame(index=accepted_idx, time_ms=time_ms, frame_bgr=frame))
                accepted_idx += 1
            frame_idx += 1
    except Exception as exc:  # noqa: BLE001
        out_queue.put(exc)
        return
    finally:
        cap.release()

    out_queue.put(_SENTINEL)


async def iter_frames(
    path: Path,
    frames_per_second: float,
    *,
    max_buffered: int = 2,
) -> AsyncIterator[ExtractedFrame]:
    """Extrai frames em streaming, um de cada vez, com memória de pico limitada.

    Roda a decodificação em uma thread separada e entrega os frames um a um
    através de uma fila (`queue.Queue`) de tamanho limitado (`max_buffered`),
    em vez de decodificar o vídeo inteiro antes de devolver qualquer coisa
    (o que manteria todos os frames aceitos — em geral 20-30 por vídeo de
    7-10s — como arrays numpy simultaneamente em memória).

    Isso é o que dá backpressure de verdade: a thread produtora bloqueia em
    `queue.put()` quando a fila está cheia, então o processo nunca mantém
    mais que `max_buffered` frames decodificados ao mesmo tempo, não
    importa a duração ou resolução do vídeo. É essencial no plano free do
    Render (teto de 512MB): em 4K, cada frame decodificado pesa ~25MB —
    segurar 20-30 de uma vez sozinho já passa dos 512MB, mesmo sem
    nenhuma concorrência.

    O consumo continua sequencial (um frame por vez, como antes) — isso não
    reintroduz concorrência, só troca "decodificar tudo, depois processar
    tudo" por "decodificar e processar em passos intercalados".
    """
    out_queue: "queue.Queue" = queue.Queue(maxsize=max_buffered)
    stop_event = threading.Event()
    thread = threading.Thread(
        target=_produce_frames,
        args=(str(path), frames_per_second, out_queue, stop_event),
        daemon=True,
    )
    thread.start()
    try:
        while True:
            item = await asyncio.to_thread(out_queue.get)
            if item is _SENTINEL:
                break
            if isinstance(item, Exception):
                raise item
            yield item
    finally:
        # Se o consumidor parar de iterar antes do fim (erro, cancelamento),
        # avisa a thread produtora para parar de decodificar e espera ela
        # encerrar — evita thread e cv2.VideoCapture órfãos.
        stop_event.set()
        await asyncio.to_thread(thread.join, 5.0)


def encode_jpeg(frame_bgr: np.ndarray, quality: int = 92) -> bytes:
    ok, buffer = cv2.imencode(".jpg", frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("Falha ao codificar frame em JPEG.")
    return buffer.tobytes()
