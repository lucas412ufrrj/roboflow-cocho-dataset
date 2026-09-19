"""
Endpoints de registro de cochos (ver `services/cocho_registry.py`).

Auxiliar de propósito: guarda uma lista de cochos conhecidos, reaproveitável
entre aparelhos, mas NÃO é de onde vem a medida usada em cada captura — essa
vai embutida (snapshot) direto em `POST /api/captures` / `/api/captures/init`
(ver `models/schemas.CaptureFormInput`). Por isso não há nenhuma checagem
cruzada entre este registro e as capturas recebidas: mesmo que o cadastro de
um cocho nunca chegue a sincronizar aqui, nenhuma captura fica bloqueada por
causa disso.

Leitura (`GET`) usa só a chave que todo o app tem (`verify_backend_api_key`,
no router inteiro) — a lista é compartilhada com a equipe toda. Escrita
(`POST`/`DELETE`) exige adicionalmente `verify_admin_api_key`, pra que só
quem administra consiga cadastrar, editar (reenviando o mesmo `cocho_id`) ou
excluir um cocho — ver comentário em `config.ADMIN_API_KEY`.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status

from app.api.deps import get_cocho_registry
from app.core.security import verify_admin_api_key, verify_backend_api_key
from app.models.schemas import CochoInput, CochoResponse
from app.services.cocho_registry import CochoRegistry

router = APIRouter(
    prefix="/api/cochos",
    tags=["cochos"],
    dependencies=[Depends(verify_backend_api_key)],
)


@router.post("", response_model=CochoResponse, dependencies=[Depends(verify_admin_api_key)])
async def registrar_cocho(
    body: CochoInput,
    registry: CochoRegistry = Depends(get_cocho_registry),
) -> CochoResponse:
    # Idempotente por cocho_id (gerado no aparelho): reenviar o mesmo cocho
    # (ex.: o app não tem certeza se a sincronização anterior deu certo)
    # apenas sobrescreve com os mesmos dados, sem duplicar nada.
    registro = await registry.upsert(
        body.cocho_id,
        {
            "cocho_id": body.cocho_id,
            "nome": body.nome,
            "comprimento_cm": body.comprimento_cm,
            "largura_cm": body.largura_cm,
            "altura_cm": body.altura_cm,
            "experimento": body.experimento,
        },
    )
    return CochoResponse(**registro)


@router.get("", response_model=list[CochoResponse])
async def listar_cochos(
    registry: CochoRegistry = Depends(get_cocho_registry),
) -> list[CochoResponse]:
    registros = await registry.list_all()
    return [CochoResponse(**registro) for registro in registros]


@router.delete(
    "/{cocho_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    dependencies=[Depends(verify_admin_api_key)],
)
async def excluir_cocho(
    cocho_id: str,
    registry: CochoRegistry = Depends(get_cocho_registry),
) -> None:
    # Não afeta nenhuma captura já enviada: a medida usada em cada captura é
    # um retrato (snapshot) já embutido nela no momento da gravação, nunca
    # uma referência a este registro. Idempotente: excluir de novo um id que
    # já não existe aqui não é erro.
    await registry.delete(cocho_id)
