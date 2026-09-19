"""
Endpoints de registro de tipos de alimento (ver `services/tipo_alimento_registry.py`).

Mesma lógica de `api/cochos.py`: guarda uma lista de tipos de alimento
conhecidos, reaproveitável entre aparelhos, mas NÃO é de onde vem o valor
usado em cada captura — esse vai embutido (snapshot) direto em
`POST /api/captures` / `/api/captures/init` (ver
`models/schemas.CaptureFormInput`). Por isso não há nenhuma checagem cruzada
entre este registro e as capturas recebidas: mesmo que o cadastro de um tipo
de alimento nunca chegue a sincronizar aqui, nenhuma captura fica bloqueada
por causa disso.

Leitura (`GET`) usa só a chave que todo o app tem (`verify_backend_api_key`,
no router inteiro) — a lista é compartilhada com a equipe toda. Escrita
(`POST`/`DELETE`) exige adicionalmente `verify_admin_api_key`, pra que só
quem administra consiga cadastrar, editar (reenviando o mesmo
`tipo_alimento_id`) ou excluir um tipo de alimento — ver comentário em
`config.ADMIN_API_KEY`.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status

from app.api.deps import get_tipo_alimento_registry
from app.core.security import verify_admin_api_key, verify_backend_api_key
from app.models.schemas import TipoAlimentoInput, TipoAlimentoResponse
from app.services.tipo_alimento_registry import TipoAlimentoRegistry

router = APIRouter(
    prefix="/api/tipos-alimento",
    tags=["tipos_alimento"],
    dependencies=[Depends(verify_backend_api_key)],
)


@router.post("", response_model=TipoAlimentoResponse, dependencies=[Depends(verify_admin_api_key)])
async def registrar_tipo_alimento(
    body: TipoAlimentoInput,
    registry: TipoAlimentoRegistry = Depends(get_tipo_alimento_registry),
) -> TipoAlimentoResponse:
    # Idempotente por tipo_alimento_id (gerado no aparelho): reenviar o
    # mesmo tipo (ex.: o app não tem certeza se a sincronização anterior deu
    # certo) apenas sobrescreve com os mesmos dados, sem duplicar nada.
    registro = await registry.upsert(
        body.tipo_alimento_id,
        {
            "tipo_alimento_id": body.tipo_alimento_id,
            "nome": body.nome,
            "densidade_aparente_kg_l": body.densidade_aparente_kg_l,
        },
    )
    return TipoAlimentoResponse(**registro)


@router.get("", response_model=list[TipoAlimentoResponse])
async def listar_tipos_alimento(
    registry: TipoAlimentoRegistry = Depends(get_tipo_alimento_registry),
) -> list[TipoAlimentoResponse]:
    registros = await registry.list_all()
    return [TipoAlimentoResponse(**registro) for registro in registros]


@router.delete(
    "/{tipo_alimento_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    dependencies=[Depends(verify_admin_api_key)],
)
async def excluir_tipo_alimento(
    tipo_alimento_id: str,
    registry: TipoAlimentoRegistry = Depends(get_tipo_alimento_registry),
) -> None:
    # Não afeta nenhuma captura já enviada: o valor usado em cada captura é
    # um retrato (snapshot) já embutido nela no momento da gravação, nunca
    # uma referência a este registro. Idempotente: excluir de novo um id que
    # já não existe aqui não é erro.
    await registry.delete(tipo_alimento_id)
