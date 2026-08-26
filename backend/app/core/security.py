"""
Segurança do backend.

- O app móvel autentica no NOSSO backend com um cabeçalho `X-Backend-Api-Key`.
- O backend é quem detém `ROBOFLOW_API_KEY` e fala com o Roboflow.
- Nenhuma chave do Roboflow trafega para o cliente em nenhuma circunstância.
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
