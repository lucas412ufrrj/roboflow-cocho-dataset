"""
Wrappers finos sobre `ffprobe`/`ffmpeg` via subprocess.

Mantemos aqui apenas chamadas de processo, sem lógica de negócio, para que
`video_processor.py` permaneça testável isoladamente (mockando estas funções).
"""

from __future__ import annotations

import asyncio
import json
import shutil
from dataclasses import dataclass
from pathlib import Path


class FFmpegNotFoundError(RuntimeError):
    pass


def _ensure_binaries() -> None:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise FFmpegNotFoundError(
            "ffmpeg/ffprobe não encontrados no PATH. Instale o pacote ffmpeg."
        )


@dataclass(frozen=True)
class VideoProbeInfo:
    duration_s: float
    codec_name: str
    width: int
    height: int
    fps: float


async def probe_video(path: Path) -> VideoProbeInfo:
    _ensure_binaries()
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height,r_frame_rate,duration",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe falhou: {stderr.decode(errors='ignore')}")

    data = json.loads(stdout.decode())
    stream = data["streams"][0]
    fmt = data.get("format", {})

    duration = stream.get("duration") or fmt.get("duration")
    if duration is None:
        raise RuntimeError("Não foi possível determinar a duração do vídeo.")

    num, den = (stream.get("r_frame_rate") or "0/1").split("/")
    fps = float(num) / float(den) if float(den) != 0 else 0.0

    return VideoProbeInfo(
        duration_s=float(duration),
        codec_name=stream.get("codec_name", "unknown"),
        width=int(stream.get("width", 0)),
        height=int(stream.get("height", 0)),
        fps=fps,
    )


async def normalize_to_h264_mp4(src: Path, dst: Path) -> None:
    """Reencoda `src` para MP4/H.264 + AAC em `dst`, caso já não esteja nesse formato."""
    _ensure_binaries()
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        str(dst),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg (normalização) falhou: {stderr.decode(errors='ignore')}")


async def reencode_for_camera_origin(
    src: Path,
    dst: Path,
    *,
    max_width: int = 1280,
    max_height: int = 720,
    video_bitrate: str = "2M",
) -> None:
    """Reencoda e limita resolução/bitrate INCONDICIONALMENTE — diferente de
    `normalize_to_h264_mp4` acima, que só reencoda quando o codec não é
    h264/avc1.

    Usada só para vídeo com origem="camera" (gravado pela câmera customizada
    do app, `CameraView` em `RecordVideoScreen.tsx`). Não confiamos nas
    opções de qualidade dessa câmera pra garantir um arquivo de tamanho
    razoável: a câmera nativa do sistema (usada antes, e ainda usada para
    vídeo de galeria) tinha esse controle confiável, mas o `CameraView` já
    demonstrou no passado ignorar `videoQuality`/`videoBitrate` no iOS e
    devolver o vídeo em resolução nativa da câmera (60MB+, estourando o
    timeout de upload). Fazendo esse corte aqui, sempre, o resultado final
    não depende mais de nenhuma configuração de câmera do aparelho — vale
    pra qualquer celular, mesmo que a gravação em si saia gigante.

    Como a origem="camera" sempre produz um vídeo curto e de duração fixa
    (~`RECORDING_DURATION_S`, ver `config.py`), o custo extra de reencodar
    sempre (em vez de só quando o codec pede) é pequeno e previsível.
    """
    _ensure_binaries()
    dst.parent.mkdir(parents=True, exist_ok=True)
    escala = f"scale='min({max_width},iw)':'min({max_height},ih)':force_original_aspect_ratio=decrease"
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-vf",
        escala,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-b:v",
        video_bitrate,
        "-maxrate",
        video_bitrate,
        "-bufsize",
        "4M",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        str(dst),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg (reencode câmera) falhou: {stderr.decode(errors='ignore')}")


def needs_normalization(probe: VideoProbeInfo, mime_type: str) -> bool:
    """Só precisa reencodar se o codec de vídeo não for H.264/avc1.

    Antes esta função também exigia o container declarado ser exatamente
    "video/mp4", e isso disparava um reencode via ffmpeg completo (caro em
    CPU e memória) para todo vídeo que chegasse como .mov/QuickTime mesmo
    já vindo em H.264 — o que acontece o tempo todo em iOS: o app declara
    "video/mp4" no multipart, mas o bridge do React Native pode reportar o
    Content-Type real (video/quicktime) baseado na extensão real do arquivo
    gravado pela câmera nativa (UIImagePickerController salva .MOV).
    `cv2.VideoCapture` (usado na extração de frames) abre .mov com H.264
    sem nenhum problema — o container declarado não importa pro nosso
    pipeline, só o codec de vídeo importa. Esse reencode desnecessário era
    o maior consumidor de memória por trás dos OOMs no Render.

    `mime_type` fica no parâmetro só para quem chama continuar logando o
    valor recebido; não influencia mais a decisão.
    """
    return probe.codec_name not in ("h264", "avc1")
