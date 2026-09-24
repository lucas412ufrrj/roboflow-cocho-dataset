"""
Segurança do backend.

- O app móvel autentica no NOSSO backend com um cabeçalho `X-Backend-Api-Key`.
- O backend é quem detém `ROBOFLOW_API_KEY` e fala com o Roboflow.
- Nenhuma chave do Roboflow trafega para o cliente em nenhuma circunstância.
- Escrita no registro de cochos (cadastrar/editar/excluir) exige, além do
  `X-Backend-Api-Key` de sempre, um segundo cabeçalho `X-Admin-Api-Key` — ver
  `verify_admin_api_key` abaixo e o comentário em `config.ADMIN_API_KEY`.
- Todo request do app carrega também `X-Device-Id` (ver
  `mobile/src/services/deviceId.ts`) — um UUID aleatório gerado uma vez por
  instalação, sem vínculo com a pessoa. Não é autenticação (não é validado
  contra nada, qualquer valor é aceito), só identificação — usado abaixo
  pra chave do limitador de taxa, e nos logs de `api/captures.py`/
  `api/chunked_uploads.py` pra diagnóstico por aparelho.
"""

from __future__ import annotations

from fastapi import Header, HTTPException, Request, status
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import get_settings


def get_rate_limit_key(request: Request) -> str:
    """Chave do limitador de taxa (`RATE_LIMIT_CAPTURES`/`RATE_LIMIT_CHUNKS`,
    ver `config.py`): por APARELHO quando o header `X-Device-Id` vier
    preenchido, caindo pro endereço IP só como fallback (app antigo, ainda
    sem o header).

    Antes disso, o limitador era só por IP (`get_remote_address`): a equipe
    inteira atrás do mesmo wifi/hotspot de campo dividia o MESMO limite, e
    uma pessoa testando bastante podia fazer a próxima requisição de OUTRA
    pessoa, num aparelho totalmente diferente, levar 429 sem ter feito nada
    de errado.
    """
    device_id = request.headers.get("X-Device-Id")
    if device_id:
        return f"device:{device_id}"
    return get_remote_address(request)


limiter = Limiter(key_func=get_rate_limit_key)


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
