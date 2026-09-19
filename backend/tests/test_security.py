from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.core import security


@pytest.fixture(autouse=True)
def usar_settings_de_teste(monkeypatch, settings):
    """Faz `get_settings()` (chamado dentro de `security.py`) devolver a
    fixture `settings` de `conftest.py`, sem depender do cache global."""
    monkeypatch.setattr(security, "get_settings", lambda: settings)


async def test_verify_backend_api_key_aceita_chave_correta():
    await security.verify_backend_api_key(x_backend_api_key="test-backend-key")


async def test_verify_backend_api_key_rejeita_chave_errada():
    with pytest.raises(HTTPException) as exc_info:
        await security.verify_backend_api_key(x_backend_api_key="chave-errada")
    assert exc_info.value.status_code == 401


async def test_verify_backend_api_key_rejeita_ausente():
    with pytest.raises(HTTPException):
        await security.verify_backend_api_key(x_backend_api_key=None)


async def test_verify_admin_api_key_aceita_chave_correta():
    await security.verify_admin_api_key(x_admin_api_key="test-admin-key")


async def test_verify_admin_api_key_rejeita_chave_de_backend():
    # A chave de admin é um segredo separado — a chave que todo o app tem
    # (BACKEND_API_KEY) não deve funcionar aqui.
    with pytest.raises(HTTPException) as exc_info:
        await security.verify_admin_api_key(x_admin_api_key="test-backend-key")
    assert exc_info.value.status_code == 401


async def test_verify_admin_api_key_rejeita_ausente():
    with pytest.raises(HTTPException):
        await security.verify_admin_api_key(x_admin_api_key=None)
