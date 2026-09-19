from __future__ import annotations

from app.services.cocho_registry import FileCochoRegistry, InMemoryCochoRegistry


async def test_upsert_e_get_in_memory():
    registry = InMemoryCochoRegistry()
    registro = await registry.upsert("cocho-1", {"nome": "Cocho de teste", "comprimento_cm": 200.0})
    assert registro["nome"] == "Cocho de teste"
    assert "criado_em" in registro

    lido = await registry.get("cocho-1")
    assert lido == registro


async def test_upsert_de_novo_sobrescreve_sem_duplicar():
    registry = InMemoryCochoRegistry()
    await registry.upsert("cocho-1", {"nome": "Nome errado"})
    await registry.upsert("cocho-1", {"nome": "Nome corrigido"})

    lido = await registry.get("cocho-1")
    assert lido["nome"] == "Nome corrigido"
    assert len(await registry.list_all()) == 1


async def test_delete_remove_e_e_idempotente():
    registry = InMemoryCochoRegistry()
    await registry.upsert("cocho-1", {"nome": "Cocho de teste"})

    await registry.delete("cocho-1")
    assert await registry.get("cocho-1") is None
    assert await registry.list_all() == []

    # Excluir de novo (ex.: reenvio depois de resposta de rede perdida) não
    # deve levantar erro nenhum.
    await registry.delete("cocho-1")


async def test_list_all_devolve_todos_os_registrados():
    registry = InMemoryCochoRegistry()
    await registry.upsert("cocho-1", {"nome": "Cocho A"})
    await registry.upsert("cocho-2", {"nome": "Cocho B"})

    nomes = {r["nome"] for r in await registry.list_all()}
    assert nomes == {"Cocho A", "Cocho B"}


async def test_file_registry_persiste_e_exclui_em_disco(tmp_path):
    path = str(tmp_path / "cochos.json")
    registry = FileCochoRegistry(path)

    await registry.upsert("cocho-1", {"nome": "Cocho de teste"})
    assert (await registry.get("cocho-1"))["nome"] == "Cocho de teste"

    # Uma segunda instância apontando pro mesmo arquivo enxerga o que a
    # primeira já gravou — é o que garante que sobreviva a um restart do
    # processo (mesmo padrão de `FileIdempotencyStore`).
    registry_2 = FileCochoRegistry(path)
    assert (await registry_2.get("cocho-1"))["nome"] == "Cocho de teste"

    await registry_2.delete("cocho-1")
    assert await registry.get("cocho-1") is None
