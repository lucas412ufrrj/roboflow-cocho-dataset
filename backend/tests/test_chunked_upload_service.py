from __future__ import annotations

import pytest

from app.models.schemas import CaptureFormInput
from app.services.chunked_upload_service import ChunkedUploadError, ChunkedUploadService
from app.storage.local_storage import LocalStorageBackend


@pytest.fixture
def service(tmp_path) -> ChunkedUploadService:
    storage = LocalStorageBackend(base_path=str(tmp_path / "storage"))
    return ChunkedUploadService(storage=storage)


def _form(**overrides) -> CaptureFormInput:
    base = dict(
        peso_kg=12.5,
        tipo_alimento_id="tipo-01",
        tipo_alimento_nome="Ração",
        tipo_alimento_densidade_aparente_kg_l=0.6,
        cocho_id="cocho-01",
        cocho_nome="Cocho de teste",
        cocho_comprimento_cm=200.0,
        cocho_largura_cm=40.0,
        cocho_altura_cm=30.0,
        cocho_experimento="2026",
        observacoes=None,
    )
    base.update(overrides)
    return CaptureFormInput(**base)


async def test_init_session_nova_devolve_lista_vazia(service: ChunkedUploadService):
    recebidos = await service.init_session(
        capture_id="cap-1",
        total_size=1500,
        chunk_size=1000,
        total_chunks=2,
        mime_type="video/mp4",
        original_filename="video.mp4",
        form=_form(),
    )
    assert recebidos == []


async def test_init_session_chamada_de_novo_preserva_blocos_ja_recebidos(service: ChunkedUploadService):
    await service.init_session(
        capture_id="cap-2", total_size=2000, chunk_size=1000, total_chunks=2,
        mime_type="video/mp4", original_filename="video.mp4", form=_form(),
    )
    await service.save_chunk(capture_id="cap-2", chunk_index=0, data=b"a" * 1000)

    # Chamar /init de novo (ex.: o app reabriu o app no meio do envio) não
    # deve apagar o progresso já feito.
    recebidos = await service.init_session(
        capture_id="cap-2", total_size=2000, chunk_size=1000, total_chunks=2,
        mime_type="video/mp4", original_filename="video.mp4", form=_form(),
    )
    assert recebidos == [0]


async def test_save_chunk_sem_sessao_lanca_erro(service: ChunkedUploadService):
    with pytest.raises(ChunkedUploadError):
        await service.save_chunk(capture_id="nunca-existiu", chunk_index=0, data=b"x")


async def test_save_chunk_indice_fora_do_intervalo_lanca_erro(service: ChunkedUploadService):
    await service.init_session(
        capture_id="cap-3", total_size=1000, chunk_size=1000, total_chunks=1,
        mime_type="video/mp4", original_filename="video.mp4", form=_form(),
    )
    with pytest.raises(ChunkedUploadError):
        await service.save_chunk(capture_id="cap-3", chunk_index=5, data=b"x")


async def _ler_tudo(leitor, size: int = 4) -> bytes:
    """Consome o leitor do jeito que `save_stream` consome: pedaço a pedaço
    até receber vazio. Usado só nos testes; em produção quem consome é o
    `StorageBackend.save_stream`."""
    partes = []
    while True:
        pedaco = await leitor.read(size)
        if not pedaco:
            return b"".join(partes)
        partes.append(pedaco)


async def test_abrir_video_montado_falta_bloco_lanca_erro(service: ChunkedUploadService):
    await service.init_session(
        capture_id="cap-4", total_size=2000, chunk_size=1000, total_chunks=2,
        mime_type="video/mp4", original_filename="video.mp4", form=_form(),
    )
    await service.save_chunk(capture_id="cap-4", chunk_index=0, data=b"a" * 1000)

    with pytest.raises(ChunkedUploadError):
        await service.abrir_video_montado("cap-4")


async def test_abrir_video_montado_entrega_blocos_na_ordem_certa(service: ChunkedUploadService):
    await service.init_session(
        capture_id="cap-5", total_size=6, chunk_size=3, total_chunks=2,
        mime_type="video/mp4", original_filename="video.mp4", form=_form(peso_kg=30.0),
    )
    # Salva fora de ordem de propósito — o stream final precisa respeitar
    # a ordem dos índices, não a ordem de chegada.
    await service.save_chunk(capture_id="cap-5", chunk_index=1, data=b"XYZ")
    await service.save_chunk(capture_id="cap-5", chunk_index=0, data=b"ABC")

    leitor, manifest = await service.abrir_video_montado("cap-5")
    assert await _ler_tudo(leitor) == b"ABCXYZ"
    assert manifest["form"]["peso_kg"] == 30.0


async def test_abrir_video_montado_respeita_o_tamanho_pedido_em_cada_read(
    service: ChunkedUploadService,
):
    """Garantia de memória: o leitor nunca devolve mais do que foi pedido,
    e só toca um bloco por vez — é isso que mantém o pico independente do
    tamanho do vídeo (ver `_LeitorDeBlocos`)."""
    await service.init_session(
        capture_id="cap-7", total_size=6, chunk_size=3, total_chunks=2,
        mime_type="video/mp4", original_filename="video.mp4", form=_form(),
    )
    await service.save_chunk(capture_id="cap-7", chunk_index=0, data=b"ABC")
    await service.save_chunk(capture_id="cap-7", chunk_index=1, data=b"XYZ")

    leitor, _ = await service.abrir_video_montado("cap-7")
    lidos = []
    while True:
        pedaco = await leitor.read(2)
        if not pedaco:
            break
        assert len(pedaco) <= 2
        lidos.append(pedaco)
    assert b"".join(lidos) == b"ABCXYZ"


async def test_abrir_video_montado_tamanho_incompativel_lanca_erro(service: ChunkedUploadService):
    await service.init_session(
        capture_id="cap-6", total_size=999, chunk_size=3, total_chunks=1,
        mime_type="video/mp4", original_filename="video.mp4", form=_form(),
    )
    await service.save_chunk(capture_id="cap-6", chunk_index=0, data=b"ABC")

    # Agora o erro só aparece ao terminar de consumir o stream: sem o vídeo
    # inteiro em memória, não há o que medir antes de começar a gravar.
    leitor, _ = await service.abrir_video_montado("cap-6")
    with pytest.raises(ChunkedUploadError):
        await _ler_tudo(leitor)


async def test_cleanup_remove_blocos_e_manifesto(service: ChunkedUploadService):
    await service.init_session(
        capture_id="cap-7", total_size=3, chunk_size=3, total_chunks=1,
        mime_type="video/mp4", original_filename="video.mp4", form=_form(),
    )
    await service.save_chunk(capture_id="cap-7", chunk_index=0, data=b"ABC")

    await service.cleanup("cap-7")

    # Depois da limpeza, a sessão não existe mais — nem pra retomar, nem pra concluir.
    recebidos = await service.init_session(
        capture_id="cap-7", total_size=3, chunk_size=3, total_chunks=1,
        mime_type="video/mp4", original_filename="video.mp4", form=_form(),
    )
    assert recebidos == []
