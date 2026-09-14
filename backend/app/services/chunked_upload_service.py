"""
Sessão de upload em blocos (retomável) para vídeos grandes.

Guarda cada bloco recebido como um objeto separado no `StorageBackend` (ver
`app/storage/base.py`) e um manifesto em JSON com os metadados da sessão e
quais blocos já chegaram. Isso permite ao app perguntar, ao retomar um envio
interrompido (perda de conexão, app fechado no meio), quais blocos ainda
faltam — em vez de reenviar o vídeo inteiro do zero. Ver `uploadCaptureEmBlocos`
em `mobile/src/api/client.ts` para o lado que consome isso.

Observação sobre durabilidade: como o armazenamento local (`STORAGE_BACKEND=
local`, o padrão) vive em disco efêmero do processo — mesma premissa já
assumida pelo resto do pipeline, onde `raw_key`/`normalized_key` em
`capture_service.py` também são temporários e limpos ao final —, reiniciar o
processo do backend no meio de um envio em blocos apaga os blocos recebidos
até então. Não é um bug: o pior caso é o app recomeçar o envio do zero na
próxima tentativa (`init_session` detecta a ausência do manifesto e responde
com `received_chunks=[]`), nunca um vídeo corrompido ou incompleto sendo
processado.
"""

from __future__ import annotations

import asyncio
import json
import logging

from app.models.schemas import CaptureFormInput
from app.storage.base import StorageBackend

logger = logging.getLogger(__name__)

# Limite de segurança por bloco — bem acima do que o app de fato usa
# (TAMANHO_BLOCO_BYTES = 512 KB em `client.ts`), só pra rejeitar cedo um
# `chunk_size` absurdo em vez de deixar alguém mandar blocos gigantes.
MAX_CHUNK_SIZE_BYTES = 8 * 1024 * 1024


class ChunkedUploadError(ValueError):
    pass


def _manifest_key(capture_id: str) -> str:
    return f"chunked_uploads/{capture_id}/manifest.json"


def _chunk_key(capture_id: str, chunk_index: int) -> str:
    return f"chunked_uploads/{capture_id}/{chunk_index:06d}.part"


class ChunkedUploadService:
    def __init__(self, storage: StorageBackend) -> None:
        self.storage = storage
        # Uma trava por capture_id evita corrida entre blocos processados
        # quase ao mesmo tempo (ex.: um retry automático e um reenvio manual
        # coincidindo) lendo e escrevendo o manifesto ao mesmo tempo. Os
        # uploads do app são sequenciais por captura, então isso é só uma
        # rede de segurança, não o caminho comum.
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock_for(self, capture_id: str) -> asyncio.Lock:
        lock = self._locks.get(capture_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[capture_id] = lock
        return lock

    async def _read_manifest(self, capture_id: str) -> dict | None:
        try:
            raw = await self.storage.read_bytes(_manifest_key(capture_id))
        except (FileNotFoundError, OSError):
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    async def _write_manifest(self, capture_id: str, manifest: dict) -> None:
        await self.storage.save_bytes(_manifest_key(capture_id), json.dumps(manifest).encode("utf-8"))

    async def init_session(
        self,
        *,
        capture_id: str,
        total_size: int,
        chunk_size: int,
        total_chunks: int,
        mime_type: str,
        original_filename: str,
        form: CaptureFormInput,
    ) -> list[int]:
        """Cria (ou retoma) a sessão de upload em blocos desse `capture_id`.

        Devolve os índices de blocos já recebidos — lista vazia numa sessão
        nova, ou depois de o processo do backend ter reiniciado no meio de
        um envio anterior (ver docstring do módulo).
        """
        if chunk_size <= 0 or chunk_size > MAX_CHUNK_SIZE_BYTES:
            raise ChunkedUploadError(f"chunk_size inválido: {chunk_size}")
        if total_chunks <= 0 or total_size <= 0:
            raise ChunkedUploadError("total_size/total_chunks precisam ser maiores que zero.")

        async with self._lock_for(capture_id):
            manifest = await self._read_manifest(capture_id)
            if manifest is None:
                manifest = {
                    "total_size": total_size,
                    "chunk_size": chunk_size,
                    "total_chunks": total_chunks,
                    "mime_type": mime_type,
                    "original_filename": original_filename,
                    "form": form.model_dump(mode="json"),
                    "received_chunks": [],
                }
                await self._write_manifest(capture_id, manifest)
            return sorted(manifest["received_chunks"])

    async def save_chunk(self, *, capture_id: str, chunk_index: int, data: bytes) -> dict:
        """Salva um bloco e atualiza o manifesto. Devolve o manifesto
        atualizado (usado pela rota só pra montar a resposta de confirmação)."""
        async with self._lock_for(capture_id):
            manifest = await self._read_manifest(capture_id)
            if manifest is None:
                raise ChunkedUploadError(
                    "Sessão de envio não encontrada — chame /api/captures/init de novo antes de enviar blocos."
                )
            if chunk_index < 0 or chunk_index >= manifest["total_chunks"]:
                raise ChunkedUploadError(f"chunk_index fora do intervalo esperado: {chunk_index}")

            await self.storage.save_bytes(_chunk_key(capture_id, chunk_index), data)

            received = set(manifest["received_chunks"])
            received.add(chunk_index)
            manifest["received_chunks"] = sorted(received)
            await self._write_manifest(capture_id, manifest)
            return manifest

    async def load_completed_video(self, capture_id: str) -> tuple[bytes, dict]:
        """Junta todos os blocos na ordem certa e devolve os bytes do vídeo
        completo junto com o manifesto (que carrega os metadados do
        formulário, salvos em `init_session`)."""
        manifest = await self._read_manifest(capture_id)
        if manifest is None:
            raise ChunkedUploadError("Sessão de envio não encontrada.")

        total_chunks = manifest["total_chunks"]
        received = set(manifest["received_chunks"])
        faltando = [i for i in range(total_chunks) if i not in received]
        if faltando:
            raise ChunkedUploadError(
                f"Faltam {len(faltando)} de {total_chunks} blocos — envie todos antes de concluir."
            )

        partes = [await self.storage.read_bytes(_chunk_key(capture_id, index)) for index in range(total_chunks)]
        video_bytes = b"".join(partes)

        if len(video_bytes) != manifest["total_size"]:
            raise ChunkedUploadError(
                f"Tamanho final do vídeo ({len(video_bytes)} bytes) não bate com o "
                f"esperado ({manifest['total_size']} bytes)."
            )

        return video_bytes, manifest

    async def cleanup(self, capture_id: str) -> None:
        """Remove todos os blocos e o manifesto dessa sessão — chamado
        depois de concluir o envio (com sucesso ou falha definitiva)."""
        manifest = await self._read_manifest(capture_id)
        if manifest is not None:
            for index in range(manifest["total_chunks"]):
                await self.storage.delete(_chunk_key(capture_id, index))
        await self.storage.delete(_manifest_key(capture_id))
        self._locks.pop(capture_id, None)
