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


class _LeitorDeBlocos:
    """Entrega os blocos já gravados no storage como um stream contínuo, na
    ordem dos índices, carregando no máximo UM bloco por vez na memória.

    Implementa só o que `StorageBackend.save_stream` exige de um stream (ver
    `AsyncReadable` em `app/storage/base.py`): um `read(size)` assíncrono que
    devolve até `size` bytes e uma sequência vazia quando acaba. É esse
    contrato mínimo que permite reaproveitar, no envio em blocos, o mesmo
    caminho de gravação por streaming que o envio único já usa.

    Confere o tamanho total no fim (quando sinaliza o fim do stream): se a
    soma dos blocos não bater com o `total_size` declarado em
    `init_session`, levanta `ChunkedUploadError` em vez de deixar seguir um
    vídeo truncado/duplicado pro pipeline. A checagem acontece no fim porque
    aqui, ao contrário da versão antiga, nunca existe um objeto com o vídeo
    inteiro pra medir antes de começar a gravar.
    """

    def __init__(
        self,
        *,
        storage: StorageBackend,
        capture_id: str,
        total_chunks: int,
        total_size_esperado: int,
    ) -> None:
        self._storage = storage
        self._capture_id = capture_id
        self._total_chunks = total_chunks
        self._total_size_esperado = total_size_esperado
        self._proximo_bloco = 0
        self._buffer = b""
        self._entregues = 0

    async def read(self, size: int = -1) -> bytes:
        if not self._buffer and self._proximo_bloco < self._total_chunks:
            self._buffer = await self._storage.read_bytes(
                _chunk_key(self._capture_id, self._proximo_bloco)
            )
            self._proximo_bloco += 1

        if not self._buffer:
            # Fim do stream: é aqui, e só aqui, que dá pra conferir o total.
            if self._entregues != self._total_size_esperado:
                raise ChunkedUploadError(
                    f"Tamanho final do vídeo ({self._entregues} bytes) não bate com o "
                    f"esperado ({self._total_size_esperado} bytes)."
                )
            return b""

        if size < 0 or size >= len(self._buffer):
            dados, self._buffer = self._buffer, b""
        else:
            dados, self._buffer = self._buffer[:size], self._buffer[size:]
        self._entregues += len(dados)
        return dados


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

    async def abrir_video_montado(self, capture_id: str) -> tuple[_LeitorDeBlocos, dict]:
        """Devolve um leitor que entrega o vídeo completo em sequência, na
        ordem certa dos blocos, junto com o manifesto (que carrega os
        metadados do formulário, salvos em `init_session`).

        O leitor nunca tem mais de um bloco em memória de cada vez (ver
        `_LeitorDeBlocos`), e é isso que separa este método do que existia
        antes aqui: a versão anterior (`load_completed_video`) lia todos os
        blocos pra uma lista e ainda fazia `b"".join(...)` em cima, ou seja,
        duas cópias do vídeo inteiro na RAM ao mesmo tempo. Como o app manda
        por blocos qualquer vídeo acima de 8MB (ver
        `LIMIAR_ENVIO_EM_BLOCOS_BYTES` em `mobile/src/api/client.ts`), era
        justamente o caminho dos vídeos GRANDES que materializava tudo em
        memória — o envio único já tinha sido corrigido pra streaming em
        15/09 e este aqui tinha ficado de fora. Com `MAX_VIDEO_SIZE_MB=150`,
        isso dava até 300MB de pico só na montagem, num processo com teto de
        512MB no Render: foi o que derrubou o serviço por falta de memória em
        22/09 (ver decisão registrada no projeto Claude).

        Quem consome isso passa o leitor direto pra
        `CaptureService.process_capture_from_stream`, que grava em disco
        conforme lê (`StorageBackend.save_stream`) sem nunca montar o vídeo
        inteiro como um único `bytes`.
        """
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

        leitor = _LeitorDeBlocos(
            storage=self.storage,
            capture_id=capture_id,
            total_chunks=total_chunks,
            total_size_esperado=manifest["total_size"],
        )
        return leitor, manifest

    async def cleanup(self, capture_id: str) -> None:
        """Remove todos os blocos e o manifesto dessa sessão — chamado
        depois de concluir o envio (com sucesso ou falha definitiva)."""
        manifest = await self._read_manifest(capture_id)
        if manifest is not None:
            for index in range(manifest["total_chunks"]):
                await self.storage.delete(_chunk_key(capture_id, index))
        await self.storage.delete(_manifest_key(capture_id))
        self._locks.pop(capture_id, None)
