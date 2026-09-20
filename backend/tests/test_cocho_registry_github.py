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

    # Cache curto de leitura (ver `_read_all_cached`): as três chamadas acima
    # aconteceram praticamente no mesmo instante, então só a primeira bateu
    # de verdade na API do GitHub — as outras duas reaproveitaram o
    # resultado em memória, exatamente o comportamento que protege contra
    # uma rajada de GETs quase simultâneos (várias pessoas abrindo o app
    # pela primeira vez de uma vez).
    assert get_route.call_count == 1
    assert not put_route.called
    await registry.aclose()


async def _sem_espera(*_args, **_kwargs) -> None:
    """Substitui `asyncio.sleep` nos testes de retry — sem isso, o backoff
    real (ver `_BACKOFF_BASE_S`) deixaria esses testes lentos de verdade."""


@respx.mock
async def test_cache_de_leitura_expira_apos_o_ttl(monkeypatch):
    dados = {"cocho-1": {"nome": "Cocho A", "criado_em": 1}}
    get_route = respx.get(CONTENTS_URL).mock(return_value=_content_response(dados, sha="sha-x"))

    registry = _make_registry()
    relogio = {"agora": 1_000.0}
    monkeypatch.setattr("app.services.cocho_registry.time.monotonic", lambda: relogio["agora"])

    await registry.get("cocho-1")
    assert get_route.call_count == 1

    # Ainda dentro do TTL: reaproveita o cache, não bate no GitHub de novo.
    relogio["agora"] += GitHubCochoRegistry._CACHE_TTL_S - 0.5
    await registry.get("cocho-1")
    assert get_route.call_count == 1

    # Passou do TTL: lê de novo de verdade.
    relogio["agora"] += 1.0
    await registry.get("cocho-1")
    assert get_route.call_count == 2
    await registry.aclose()


@respx.mock
async def test_escrita_bem_sucedida_invalida_o_cache_de_leitura():
    respx.get(CONTENTS_URL).mock(
        side_effect=[
            _content_response({}, sha="sha-1"),  # list_all() inicial (cache vazio)
            _content_response({}, sha="sha-1"),  # leitura interna do upsert
            _content_response(
                {"cocho-1": {"nome": "Cocho A", "criado_em": 1}}, sha="sha-2"
            ),  # list_all() após a escrita invalidar o cache
        ]
    )
    respx.put(CONTENTS_URL).mock(return_value=httpx.Response(200, json={"content": {"sha": "sha-2"}}))

    registry = _make_registry()
    assert await registry.list_all() == []
    await registry.upsert("cocho-1", {"nome": "Cocho A"})
    # Sem a invalidação (`_write_all` -> `_invalidar_cache`), isso ainda
    # devolveria a lista vazia guardada em cache antes da escrita.
    nomes = {r["nome"] for r in await registry.list_all()}
    assert nomes == {"Cocho A"}
    await registry.aclose()


@respx.mock
async def test_erro_5xx_transitorio_no_get_e_tentado_de_novo(monkeypatch):
    monkeypatch.setattr("app.services.cocho_registry.asyncio.sleep", _sem_espera)
    dados = {"cocho-1": {"nome": "Cocho A", "criado_em": 1}}
    get_route = respx.get(CONTENTS_URL).mock(
        side_effect=[
            httpx.Response(503, text="service unavailable"),
            _content_response(dados, sha="sha-1"),
        ]
    )

    registry = _make_registry()
    registro = await registry.get("cocho-1")

    assert registro["nome"] == "Cocho A"
    assert get_route.call_count == 2
    await registry.aclose()


@respx.mock
async def test_403_de_rate_limit_e_tratado_como_transitorio(monkeypatch):
    monkeypatch.setattr("app.services.cocho_registry.asyncio.sleep", _sem_espera)
    dados = {"cocho-1": {"nome": "Cocho A", "criado_em": 1}}
    get_route = respx.get(CONTENTS_URL).mock(
        side_effect=[
            httpx.Response(403, json={"message": "API rate limit exceeded for user"}),
            _content_response(dados, sha="sha-1"),
        ]
    )

    registry = _make_registry()
    registro = await registry.get("cocho-1")

    assert registro["nome"] == "Cocho A"
    assert get_route.call_count == 2
    await registry.aclose()


@respx.mock
async def test_403_de_credencial_invalida_nao_e_tratado_como_transitorio():
    # "Bad credentials" não tem nenhuma das palavras que
    # `_resposta_e_transitoria` reconhece como rate limit/abuse detection —
    # insistir não resolveria nada, então propaga na primeira tentativa.
    get_route = respx.get(CONTENTS_URL).mock(
        return_value=httpx.Response(403, json={"message": "Bad credentials"})
    )

    registry = _make_registry()
    with pytest.raises(httpx.HTTPStatusError):
        await registry.get("cocho-1")

    assert get_route.call_count == 1
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
