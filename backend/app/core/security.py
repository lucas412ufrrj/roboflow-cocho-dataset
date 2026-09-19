"""
Segurança do backend.

- O app móvel autentica no NOSSO backend com um cabeçalho `X-Backend-Api-Key`.
- O backend é quem detém `ROBOFLOW_API_KEY` e fala com o Roboflow.
- Nenhuma chave do Roboflow trafega para o cliente em nenhuma circunstância.
- Escrita no registro de cochos (cadastrar/editar/excluir) exige, além do
  `X-Backend-Api-Key` de sempre, um segundo cabeçalho `X-Admin-Api-Key` — ver
  `verify_admin_api_key` abaixo e o comentário em `config.ADMIN_API_KEY`.
"""

from __future__ import annotations

from fastapi import Header, HTTPException, status
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import get_settings

limiter = Limiter(key_func=get_remote_address)


async def verify_backend_api_key(
    x_backend_api_key: str | None = Header(default=None, alias="X-Backend-Api-Key"),
) -> None:
    """Valida a chave de autenticação do app móvel no backend (não é a chave Roboflow)."""
    settings = get_settings()
    if not x_backend_api_key or x_backend_api_key != settings.BACKEND_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciais inválidas para acessar o backend.",
        )


async def verify_admin_api_key(
    x_admin_api_key: str | None = Header(default=None, alias="X-Admin-Api-Key"),
) -> None:
    """
    Valida a chave de administrador, exigida além de `verify_backend_api_key`
    nos endpoints de escrita do registro de cochos (`POST`/`DELETE` em
    `api/cochos.py`). Todo o app tem a chave de `verify_backend_api_key`; só
    quem administra a lista de cochos deve ter esta aqui.
    """
    settings = get_settings()
    if not x_admin_api_key or x_admin_api_key != settings.ADMIN_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Chave de administrador inválida ou ausente.",
        )
