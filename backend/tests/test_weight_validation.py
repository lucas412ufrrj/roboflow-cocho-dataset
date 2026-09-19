from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.models.schemas import CaptureFormInput

# Medidas de cocho, obrigatórias em todo CaptureFormInput desde que o
# cadastro de cochos passou a existir (ver models/schemas.py) — snapshot
# embutido no momento da gravação, nunca opcional.
_COCHO_KWARGS = dict(
    cocho_id="cocho-01",
    cocho_nome="Cocho de teste",
    cocho_comprimento_cm=200.0,
    cocho_largura_cm=40.0,
    cocho_altura_cm=30.0,
    cocho_experimento="2026",
)


def test_aceita_peso_decimal_valido():
    form = CaptureFormInput(peso_kg=12.345, **_COCHO_KWARGS)
    assert form.peso_kg == pytest.approx(12.345)


def test_aceita_peso_inteiro():
    form = CaptureFormInput(peso_kg=10, **_COCHO_KWARGS)
    assert form.peso_kg == pytest.approx(10.0)


def test_rejeita_peso_zero():
    with pytest.raises(ValidationError):
        CaptureFormInput(peso_kg=0, **_COCHO_KWARGS)


def test_rejeita_peso_negativo():
    with pytest.raises(ValidationError):
        CaptureFormInput(peso_kg=-5.0, **_COCHO_KWARGS)


def test_rejeita_peso_acima_do_maximo():
    with pytest.raises(ValidationError):
        CaptureFormInput(peso_kg=999_999.0, **_COCHO_KWARGS)


def test_rejeita_cocho_id_ou_nome_em_branco():
    # Diferente de tipo_alimento/observacoes: cocho_id e cocho_nome são
    # obrigatórios, então em branco é erro, não None.
    with pytest.raises(ValidationError):
        CaptureFormInput(peso_kg=5.0, **{**_COCHO_KWARGS, "cocho_id": ""})
    with pytest.raises(ValidationError):
        CaptureFormInput(peso_kg=5.0, **{**_COCHO_KWARGS, "cocho_nome": "   "})


def test_rejeita_cocho_experimento_em_branco():
    # Mesmo tratamento de cocho_id/cocho_nome: separado do id, mas igualmente
    # obrigatório (ver comentário em CaptureFormInput.cocho_experimento).
    with pytest.raises(ValidationError):
        CaptureFormInput(peso_kg=5.0, **{**_COCHO_KWARGS, "cocho_experimento": "   "})


def test_rejeita_dimensao_de_cocho_fora_da_faixa():
    with pytest.raises(ValidationError):
        CaptureFormInput(peso_kg=5.0, **{**_COCHO_KWARGS, "cocho_comprimento_cm": 0.1})
    with pytest.raises(ValidationError):
        CaptureFormInput(peso_kg=5.0, **{**_COCHO_KWARGS, "cocho_altura_cm": 999_999.0})


def test_campos_opcionais_em_branco_viram_none():
    form = CaptureFormInput(peso_kg=5.0, tipo_alimento="  ", observacoes=None, **_COCHO_KWARGS)
    assert form.tipo_alimento is None
    assert form.observacoes is None


def test_campos_opcionais_preenchidos_sao_mantidos():
    form = CaptureFormInput(
        peso_kg=5.0,
        tipo_alimento="Silagem",
        observacoes="Dia chuvoso",
        **_COCHO_KWARGS,
    )
    assert form.tipo_alimento == "Silagem"
    assert form.cocho_id == "cocho-01"
    assert form.cocho_nome == "Cocho de teste"
    assert form.cocho_experimento == "2026"
    assert form.observacoes == "Dia chuvoso"


def test_peso_e_arredondado_em_tres_casas():
    form = CaptureFormInput(peso_kg=12.34567, **_COCHO_KWARGS)
    assert form.peso_kg == pytest.approx(12.346)
