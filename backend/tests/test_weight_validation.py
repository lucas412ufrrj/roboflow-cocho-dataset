from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.models.schemas import CaptureFormInput


def test_aceita_peso_decimal_valido():
    form = CaptureFormInput(peso_kg=12.345)
    assert form.peso_kg == pytest.approx(12.345)


def test_aceita_peso_inteiro():
    form = CaptureFormInput(peso_kg=10)
    assert form.peso_kg == pytest.approx(10.0)


def test_rejeita_peso_zero():
    with pytest.raises(ValidationError):
        CaptureFormInput(peso_kg=0)


def test_rejeita_peso_negativo():
    with pytest.raises(ValidationError):
        CaptureFormInput(peso_kg=-5.0)


def test_rejeita_peso_acima_do_maximo():
    with pytest.raises(ValidationError):
        CaptureFormInput(peso_kg=999_999.0)


def test_campos_opcionais_em_branco_viram_none():
    form = CaptureFormInput(peso_kg=5.0, tipo_alimento="  ", cocho_id="", observacoes=None)
    assert form.tipo_alimento is None
    assert form.cocho_id is None
    assert form.observacoes is None


def test_campos_opcionais_preenchidos_sao_mantidos():
    form = CaptureFormInput(
        peso_kg=5.0,
        tipo_alimento="Silagem",
        cocho_id="cocho-01",
        observacoes="Dia chuvoso",
    )
    assert form.tipo_alimento == "Silagem"
    assert form.cocho_id == "cocho-01"
    assert form.observacoes == "Dia chuvoso"


def test_peso_e_arredondado_em_tres_casas():
    form = CaptureFormInput(peso_kg=12.34567)
    assert form.peso_kg == pytest.approx(12.346)
