"""Extração de frames de um vídeo usando OpenCV, a uma taxa configurável (fps)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass(frozen=True)
class ExtractedFrame:
    index: int
    time_ms: int
    frame_bgr: np.ndarray


def _extract_sync(path: str, frames_per_second: float) -> list[ExtractedFrame]:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError(f"Não foi possível abrir o vídeo para extração: {path}")

    source_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if source_fps <= 0:
        source_fps = 30.0

    step = max(1, round(source_fps / frames_per_second))

    extracted: list[ExtractedFrame] = []
    frame_idx = 0
    accepted_idx = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_idx % step == 0:
                time_ms = int((frame_idx / source_fps) * 1000)
                extracted.append(
                    ExtractedFrame(index=accepted_idx, time_ms=time_ms, frame_bgr=frame)
                )
                accepted_idx += 1
            frame_idx += 1
    finally:
        cap.release()

    return extracted


async def extract_frames(path: Path, frames_per_second: float) -> list[ExtractedFrame]:
    """Extrai ~`frames_per_second` frames por segundo do vídeo em `path`."""
    return await asyncio.to_thread(_extract_sync, str(path), frames_per_second)


def encode_jpeg(frame_bgr: np.ndarray, quality: int = 92) -> bytes:
    ok, buffer = cv2.imencode(".jpg", frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("Falha ao codificar frame em JPEG.")
    return buffer.tobytes()
