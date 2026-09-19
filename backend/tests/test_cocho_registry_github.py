"""
Testes de GitHubCochoRegistry — alternativa gratuita e durável (nunca
expira/pausa) a um Persistent Disk pago do Render, escolhida em 2026-09-19
pra resolver o registro de cochos sendo apagado a cada deploy. Ver
comentário completo em `app/services/cocho_registry.GitHubCochoRegistry`.

Usa `respx` (mesmo padrão de `test_roboflow_upload_integration.py`) pra
simular a API REST do GitHub (Contents API) sem rede real.
"""

from __future__ import annotations

import base64
import json

import httpx
import pytest
import respx

from app.services.cocho_registry import GitHubCochoRegistry

REPO = "usuario/repo"
PATH = "backend/_data/cochos.json"
CONTENTS_URL = f"https://api.github.com/repos/{REPO}/contents/{PATH}"


def _content_response(dados: dict, sha: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "content": base64.b64encode(json.dumps(dados).encode("utf-8")).decode("ascii"),
            "sha": sha,
            "encoding": "base64",
        },
    )


def _make_registry() -> GitHubCochoRegistry:
    return GitHubCochoRegistry(token="fake-token", repo=REPO, path=PATH)


def test_token_vazio_levanta_erro_na_hora():
    with pytest.raises(ValueError):
        GitHubCochoRegistry(token="", repo=REPO, path=PATH)


def test_repo_vazio_levanta_erro_na_hora():
    with pytest.raises(ValueError):
        GitHubCochoRegistry(token="fake-token", repo="", path=PATH)


@respx.mock
async def test_upsert_cria_arquivo_quando_ainda_nao_existe_no_repo():
    respx.get(CONTENTS_URL).mock(return_value=httpx.Response(404))
    put_route = respx.put(CONTENTS_URL).mock(
        return_value=httpx.Response(200, json={"content": {"sha": "sha-1"}})
    )

    registry = _make_registry()
    registro = await registry.upsert("cocho-1", {"nome": "Cocho A"})

    assert registro["nome"] == "Cocho A"
    assert "criado_em" in registro
    assert put_route.called
    payload = json.loads(put_route.calls.last.request.content)
    assert "sha" not in payload  # arquivo novo: PUT não manda sha
    gravado = json.loads(base64.b64decode(payload["content"]))
    assert gravado == {"cocho-1": registro}
    await registry.aclose()


@respx.mock
async def test_upsert_faz_merge_raso_e_preserva_criado_em():
    existente = {"cocho-1": {"nome": "Nome antigo", "comprimento_cm": 200.0, "criado_em": 123}}
    respx.get(CONTENTS_URL).mock(return_value=_content_response(existente, sha="sha-antigo"))
    put_route = respx.put(CONTENTS_URL).mock(
        return_value=httpx.Response(200, json={"content": {"sha": "sha-novo"}})
    )

    registry = _make_registry()
    registro = await registry.upsert("cocho-1", {"nome": "Nome novo"})

    assert registro["nome"] == "Nome novo"
    assert registro["comprimento_cm"] == 200.0  # preservado do merge raso
    assert registro["criado_em"] == 123  # não sobrescreve na segunda vez
    payload = json.loads(put_route.calls.last.request.content)
    assert payload["sha"] == "sha-antigo"
    await registry.aclose()


@respx.mock
async def test_get_e_list_all_leem_sem_escrever():
    dados = {
        "cocho-1": {"nome": "Cocho A", "criado_em": 1},
        "cocho-2": {"nome": "Cocho B", "criado_em": 2},
    }
    get_route = respx.get(CONTENTS_URL).mock(return_value=_content_response(dados, sha="sha-x"))
    put_route = respx.put(CONTENTS_URL)

    registry = _make_registry()
    assert (await registry.get("cocho-1"))["nome"] == "Cocho A"
    assert await registry.get("cocho-inexistente") is None
    nomes = {r["nome"] for r in await registry.list_all()}
    assert nomes == {"Cocho A", "Cocho B"}

    assert get_route.call_count == 3
    assert not put_route.called
    await registry.aclose()


@respx.mock
async def test_delete_remove_e_e_idempotente():
    dados = {"cocho-1": {"nome": "Cocho A", "criado_em": 1}}
    respx.get(CONTENTS_URL).mock(
        side_effect=[
            _content_response(dados, sha="sha-1"),
            _content_response({}, sha="sha-2"),
        ]
    )
    respx.put(CONTENTS_URL).mock(
        return_value=httpx.Response(200, json={"content": {"sha": "sha-2"}})
    )

    registry = _make_registry()
    await registry.delete("cocho-1")
    # Excluir de novo (ex.: reenvio depois de resposta de rede perdida) não
    # deve levantar erro nenhum — mesma garantia de FileCochoRegistry.
    await registry.delete("cocho-1")
    await registry.aclose()


@respx.mock
async def test_conflito_409_tenta_de_novo_com_sha_atualizado():
    respx.get(CONTENTS_URL).mock(
        side_effect=[
            _content_response({}, sha="sha-1"),
            _content_response({}, sha="sha-2"),
        ]
    )
    put_route = respx.put(CONTENTS_URL)
    put_route.mock(
        side_effect=[
            httpx.Response(409, json={"message": "sha mismatch"}),
            httpx.Response(200, json={"content": {"sha": "sha-3"}}),
        ]
    )

    registry = _make_registry()
    registro = await registry.upsert("cocho-1", {"nome": "Cocho A"})

    assert registro["nome"] == "Cocho A"
    assert put_route.call_count == 2
    await registry.aclose()


@respx.mock
async def test_conflito_409_persistente_levanta_erro_apos_tentativas():
    respx.get(CONTENTS_URL).mock(return_value=_content_response({}, sha="sha-1"))
    respx.put(CONTENTS_URL).mock(return_value=httpx.Response(409, json={"message": "sha mismatch"}))

    registry = _make_registry()
    with pytest.raises(RuntimeError):
        await registry.upsert("cocho-1", {"nome": "Cocho A"})
    await registry.aclose()
