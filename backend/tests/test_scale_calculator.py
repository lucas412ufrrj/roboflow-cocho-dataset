from __future__ import annotations

import pytest

from app.services.scale_calculator import (
    area_poligono_cm2,
    area_poligono_px,
    escala_cm_por_pixel,
)


def test_escala_cm_por_pixel_calcula_fator_correto():
    # Duas pontas a 100px de distância representando um cocho de 200cm de
    # comprimento -> cada pixel vale 2cm.
    fator = escala_cm_por_pixel((0.0, 0.0), (100.0, 0.0), comprimento_real_cm=200.0)
    assert fator == pytest.approx(2.0)


def test_escala_cm_por_pixel_funciona_na_diagonal():
    # Distância euclidiana, não só no eixo x.
    fator = escala_cm_por_pixel((0.0, 0.0), (3.0, 4.0), comprimento_real_cm=10.0)
    assert fator == pytest.approx(2.0)  # distância = 5px, 10cm / 5px = 2cm/px


def test_escala_cm_por_pixel_descarta_deteccao_degenerada():
    # As duas pontas praticamente no mesmo lugar — detecção ruim, não dá pra
    # confiar num fator calculado a partir disso.
    fator = escala_cm_por_pixel((10.0, 10.0), (10.3, 10.0), comprimento_real_cm=200.0)
    assert fator is None


def test_area_poligono_px_calcula_area_de_um_retangulo():
    # Retângulo 10x20 -> área 200.
    pontos = [(0.0, 0.0), (10.0, 0.0), (10.0, 20.0), (0.0, 20.0)]
    assert area_poligono_px(pontos) == pytest.approx(200.0)


def test_area_poligono_px_funciona_independente_do_formato():
    # Um triângulo qualquer, só pra confirmar que a fórmula não assume
    # nenhum formato específico de cocho.
    pontos = [(0.0, 0.0), (4.0, 0.0), (0.0, 3.0)]
    assert area_poligono_px(pontos) == pytest.approx(6.0)


def test_area_poligono_px_com_menos_de_3_pontos_e_zero():
    assert area_poligono_px([(0.0, 0.0), (1.0, 1.0)]) == 0.0
    assert area_poligono_px([]) == 0.0


def test_area_poligono_cm2_aplica_escala_ao_quadrado():
    # Quadrado 10x10px = 100px². Com escala 2cm/px, a área real é
    # 100 * (2**2) = 400cm², não 100*2=200cm² (erro comum de esquecer que
    # área escala ao quadrado, não linearmente).
    pontos = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    assert area_poligono_cm2(pontos, escala_cm_por_px=2.0) == pytest.approx(400.0)
