from __future__ import annotations

from datetime import datetime, timezone

from app.config import get_settings
from app.models.schemas import CaptureFormInput

# Medidas de cocho + tipo de alimento, obrigatórias em todo CaptureFormInput —
# ver o mesmo padrão em test_weight_validation.py.
_COCHO_KWARGS = dict(
    cocho_id="cocho-01",
    cocho_nome="Cocho de teste",
    cocho_comprimento_cm=200.0,
    cocho_largura_cm=40.0,
    cocho_altura_cm=30.0,
    cocho_experimento="2026",
)
_TIPO_ALIMENTO_KWARGS = dict(
    tipo_alimento_id="tipo-01",
    tipo_alimento_nome="Silagem",
    tipo_alimento_densidade_aparente_kg_l=0.6,
)


def _agora_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _form(recorded_at: int | None) -> CaptureFormInput:
    return CaptureFormInput(
        peso_kg=5.0, recorded_at=recorded_at, **_COCHO_KWARGS, **_TIPO_ALIMENTO_KWARGS
    )


def test_recorded_at_ausente_continua_none():
    assert _form(None).recorded_at is None


def test_recorded_at_zero_ou_negativo_vira_none():
    assert _form(0).recorded_at is None
    assert _form(-1000).recorded_at is None


def test_recorded_at_recente_e_preservado():
    valor = _agora_ms() - 5 * 60 * 1000  # 5 minutos atrás
    assert _form(valor).recorded_at == valor


def test_recorded_at_dentro_da_tolerancia_de_futuro_e_preservado():
    settings = get_settings()
    # Metade da tolerância configurada — claramente dentro da janela aceita,
    # cobre diferença de fuso/relógio não perfeitamente sincronizado.
    valor = _agora_ms() + (settings.RECORDED_AT_TOLERANCIA_FUTURO_MIN // 2) * 60 * 1000
    assert _form(valor).recorded_at == valor


def test_recorded_at_muito_no_futuro_vira_none():
    settings = get_settings()
    valor = _agora_ms() + (settings.RECORDED_AT_TOLERANCIA_FUTURO_MIN + 60) * 60 * 1000
    assert _form(valor).recorded_at is None


def test_recorded_at_muito_no_passado_vira_none():
    # Data de modificação de um arquivo reaproveitado/copiado de anos atrás —
    # cenário real que motivou esta checagem (ver decisoes-anotacao.md).
    settings = get_settings()
    anos_alem_do_limite = settings.RECORDED_AT_MAX_ANOS_PASSADO + 2
    valor = _agora_ms() - anos_alem_do_limite * 365 * 24 * 60 * 60 * 1000
    assert _form(valor).recorded_at is None


def test_recorded_at_dentro_do_limite_de_passado_e_preservado():
    settings = get_settings()
    # Um pouco DENTRO do limite configurado (não além dele).
    valor = _agora_ms() - (settings.RECORDED_AT_MAX_ANOS_PASSADO * 365 - 1) * 24 * 60 * 60 * 1000
    assert _form(valor).recorded_at == valor
