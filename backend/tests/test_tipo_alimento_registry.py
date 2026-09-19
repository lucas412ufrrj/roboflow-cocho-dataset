from __future__ import annotations

from app.services.tipo_alimento_registry import FileTipoAlimentoRegistry, InMemoryTipoAlimentoRegistry


async def test_upsert_e_get_in_memory():
    registry = InMemoryTipoAlimentoRegistry()
    registro = await registry.upsert("tipo-1", {"nome": "Silagem", "densidade_aparente_kg_l": 0.6})
    assert registro["nome"] == "Silagem"
    assert "criado_em" in registro

    lido = await registry.get("tipo-1")
    assert lido == registro


async def test_upsert_de_novo_sobrescreve_sem_duplicar():
    registry = InMemoryTipoAlimentoRegistry()
    await registry.upsert("tipo-1", {"nome": "Nome errado"})
    await registry.upsert("tipo-1", {"nome": "Nome corrigido"})

    lido = await registry.get("tipo-1")
    assert lido["nome"] == "Nome corrigido"
    assert len(await registry.list_all()) == 1


async def test_delete_remove_e_e_idempotente():
    registry = InMemoryTipoAlimentoRegistry()
    await registry.upsert("tipo-1", {"nome": "Silagem"})

    await registry.delete("tipo-1")
    assert await registry.get("tipo-1") is None
    assert await registry.list_all() == []

    # Excluir de novo (ex.: reenvio depois de resposta de rede perdida) não
    # deve levantar erro nenhum.
    await registry.delete("tipo-1")


async def test_list_all_devolve_todos_os_registrados():
    registry = InMemoryTipoAlimentoRegistry()
    await registry.upsert("tipo-1", {"nome": "Silagem"})
    await registry.upsert("tipo-2", {"nome": "Ração"})

    nomes = {r["nome"] for r in await registry.list_all()}
    assert nomes == {"Silagem", "Ração"}


async def test_file_registry_persiste_e_exclui_em_disco(tmp_path):
    path = str(tmp_path / "tipos_alimento.json")
    registry = FileTipoAlimentoRegistry(path)

    await registry.upsert("tipo-1", {"nome": "Silagem"})
    assert (await registry.get("tipo-1"))["nome"] == "Silagem"

    # Uma segunda instância apontando pro mesmo arquivo enxerga o que a
    # primeira já gravou — é o que garante que sobreviva a um restart do
    # processo (mesmo padrão de FileCochoRegistry/FileIdempotencyStore).
    registry_2 = FileTipoAlimentoRegistry(path)
    assert (await registry_2.get("tipo-1"))["nome"] == "Silagem"

    await registry_2.delete("tipo-1")
    assert await registry.get("tipo-1") is None
