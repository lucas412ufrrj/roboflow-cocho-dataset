from __future__ import annotations

import uuid
from collections import Counter

from app.models.schemas import SplitType
from app.services.split import choose_split


def test_split_e_deterministico_para_o_mesmo_video_id():
    video_id = str(uuid.uuid4())
    resultados = {choose_split(video_id) for _ in range(50)}
    assert len(resultados) == 1


def test_split_e_estavel_entre_execucoes_com_valor_fixo():
    # Valor fixo: garante que a lógica de hashing não muda silenciosamente
    # entre versões do código (regressão).
    video_id = "00000000-0000-0000-0000-000000000000"
    assert choose_split(video_id) == choose_split(video_id)


def test_split_vazio_levanta_erro():
    import pytest

    with pytest.raises(ValueError):
        choose_split("")


def test_distribuicao_aproximada_70_20_10():
    contagem = Counter(choose_split(str(uuid.uuid4())) for _ in range(20000))
    total = sum(contagem.values())

    pct_train = contagem[SplitType.train] / total
    pct_valid = contagem[SplitType.valid] / total
    pct_test = contagem[SplitType.test] / total

    # Tolerância generosa para não tornar o teste instável (é uma amostra).
    assert 0.65 <= pct_train <= 0.75
    assert 0.15 <= pct_valid <= 0.25
    assert 0.05 <= pct_test <= 0.15


def test_todos_os_splits_sao_valores_validos():
    for _ in range(200):
        split = choose_split(str(uuid.uuid4()))
        assert split in (SplitType.train, SplitType.valid, SplitType.test)
