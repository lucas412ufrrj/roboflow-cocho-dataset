"""
Conversão de geometria em pixel para medidas físicas em centímetros.

Depende só de duas coisas que já existem hoje: a geometria que o modelo 1 (o
validador de cocho, `trough_validator.py`) já produz ao segmentar o cocho, e
o `comprimento_cm` registrado pela pessoa pro cocho selecionado (ver
`CochosScreen.tsx` no app e `CaptureFormInput.cocho_comprimento_cm` no
backend). Não depende do modelo do alimento — esse ainda não existe, porque
precisa de uma classe nova anotada no Roboflow (ver decisão registrada na
conversa do projeto). Quando esse modelo existir, a mesma função
`area_poligono_cm2` abaixo será reaproveitada pra medir a área do alimento;
só muda qual polígono é passado pra ela, a matemática é a mesma.

Este módulo não faz nenhuma chamada de rede nem depende do FastAPI — é
matemática pura, fácil de testar isoladamente (ver
`tests/test_scale_calculator.py`).
"""

from __future__ import annotations

Ponto = tuple[float, float]


def escala_cm_por_pixel(
    ponta_a_px: Ponto,
    ponta_b_px: Ponto,
    comprimento_real_cm: float,
    distancia_minima_px: float = 1.0,
) -> float | None:
    """
    Compara a distância em pixel entre as duas extremidades do cocho (que o
    modelo 1 já detecta) com o comprimento real registrado no cadastro do
    cocho, e devolve quantos centímetros cada pixel representa nesta imagem.

    Devolve `None` quando a distância em pixel é pequena/degenerada demais
    pra confiar (as duas detecções praticamente se sobrepondo, por exemplo) —
    nesse caso é melhor não gerar nenhuma medida do que gerar uma medida
    absurda a partir de uma divisão por um número perto de zero.
    """
    dx = ponta_b_px[0] - ponta_a_px[0]
    dy = ponta_b_px[1] - ponta_a_px[1]
    distancia_px = (dx**2 + dy**2) ** 0.5
    if distancia_px < distancia_minima_px:
        return None
    return comprimento_real_cm / distancia_px


def area_poligono_px(pontos_px: list[Ponto]) -> float:
    """
    Área de um polígono em pixel, pela fórmula do sapateiro (shoelace).

    É exatamente o formato que o Roboflow devolve pra segmentação de
    instância: uma lista ordenada de vértices do contorno. Com a área vindo
    direto do contorno real detectado, não existe "fórmula por formato de
    cocho" nenhuma pra escolher — a mesma conta serve pra um cocho cilíndrico,
    oval ou retangular, porque o contorno já reflete a forma de cada um.
    """
    n = len(pontos_px)
    if n < 3:
        return 0.0
    soma = 0.0
    for i in range(n):
        x1, y1 = pontos_px[i]
        x2, y2 = pontos_px[(i + 1) % n]
        soma += x1 * y2 - x2 * y1
    return abs(soma) / 2.0


def area_poligono_cm2(pontos_px: list[Ponto], escala_cm_por_px: float) -> float:
    """
    Área real (cm²) do polígono. O fator de escala entra ao quadrado porque
    ele converte comprimento (cm/pixel), e área é comprimento vezes
    comprimento.
    """
    return area_poligono_px(pontos_px) * (escala_cm_por_px**2)
