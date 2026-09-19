from __future__ import annotations

from app.models.schemas import FrameMetadata

# Medidas de cocho, obrigatórias em toda FrameMetadata desde que o cadastro de
# cochos passou a existir (ver models/schemas.py) — snapshot embutido no
# momento da gravação, nunca opcional.
_COCHO_KWARGS = dict(
    cocho_id="cocho-07",
    cocho_nome="Cocho de teste",
    cocho_comprimento_cm=200.0,
    cocho_largura_cm=40.0,
    cocho_altura_cm=30.0,
    cocho_experimento="2026",
)


def test_metadata_contem_todos_os_campos_exigidos():
    meta = FrameMetadata(
        peso_kg=42.5,
        video_id="video-123",
        frame_time_ms=1500,
        focus_score=210.7,
        cocho_completo=True,
        tipo_alimento="Ração",
        tipo_alimento_densidade_aparente_kg_l=0.6,
        observacoes="Teste",
        **_COCHO_KWARGS,
    )
    data = meta.to_json_dict()

    campos_esperados = {
        "peso_kg",
        "video_id",
        "frame_time_ms",
        "focus_score",
        "cocho_completo",
        "tipo_alimento",
        "tipo_alimento_densidade_aparente_kg_l",
        "cocho_id",
        "cocho_nome",
        "cocho_comprimento_cm",
        "cocho_largura_cm",
        "cocho_altura_cm",
        "cocho_experimento",
        "observacoes",
    }
    assert campos_esperados.issubset(data.keys())
    assert data["peso_kg"] == 42.5
    assert data["video_id"] == "video-123"
    assert data["cocho_completo"] is True
    assert data["cocho_nome"] == "Cocho de teste"
    assert data["tipo_alimento_densidade_aparente_kg_l"] == 0.6


def test_metadata_campos_realmente_opcionais_podem_ser_none():
    # tipo_alimento/tipo_alimento_densidade_aparente_kg_l/observacoes/
    # recorded_at/operador continuam opcionais — só o snapshot do cocho (ver
    # `_COCHO_KWARGS`) deixou de ser.
    meta = FrameMetadata(
        peso_kg=10.0,
        video_id="video-abc",
        frame_time_ms=0,
        focus_score=150.0,
        cocho_completo=True,
        **_COCHO_KWARGS,
    )
    data = meta.to_json_dict()
    assert data["tipo_alimento"] is None
    assert data["tipo_alimento_densidade_aparente_kg_l"] is None
    assert data["observacoes"] is None
    assert data["recorded_at"] is None
    assert data["operador"] is None


def test_todos_os_frames_do_mesmo_video_compartilham_video_id_e_peso():
    video_id = "video-xyz"
    peso_kg = 33.0

    frame_a = FrameMetadata(
        peso_kg=peso_kg, video_id=video_id, frame_time_ms=0, focus_score=200.0, cocho_completo=True, **_COCHO_KWARGS
    )
    frame_b = FrameMetadata(
        peso_kg=peso_kg, video_id=video_id, frame_time_ms=333, focus_score=180.0, cocho_completo=True, **_COCHO_KWARGS
    )

    assert frame_a.video_id == frame_b.video_id == video_id
    assert frame_a.peso_kg == frame_b.peso_kg == peso_kg


def test_metadata_serializa_para_json_valido():
    meta = FrameMetadata(
        peso_kg=5.5,
        video_id="v1",
        frame_time_ms=100,
        focus_score=99.9,
        cocho_completo=False,
        **_COCHO_KWARGS,
    )
    json_str = meta.model_dump_json()
    assert '"peso_kg":5.5' in json_str.replace(" ", "")


def test_metadata_limita_numeros_a_quatro_casas_decimais():
    # focus_score (variância do Laplaciano) e escala/área (conversões
    # geométricas) chegam de cálculos em ponto flutuante sem nenhuma precisão
    # real além da 4ª casa — antes desta checagem, saíam sem nenhum
    # arredondamento.
    meta = FrameMetadata(
        peso_kg=42.123456,
        video_id="video-123",
        frame_time_ms=0,
        focus_score=123.456789123,
        cocho_completo=True,
        tipo_alimento_densidade_aparente_kg_l=0.123456789,
        escala_cm_por_pixel=0.673333333333,
        cocho_area_cm2=6800.66666666667,
        **_COCHO_KWARGS,
    )

    def casas_decimais(valor: float) -> int:
        texto = repr(valor)
        return len(texto.split(".")[1]) if "." in texto else 0

    for campo in (
        "peso_kg",
        "focus_score",
        "tipo_alimento_densidade_aparente_kg_l",
        "escala_cm_por_pixel",
        "cocho_area_cm2",
        "cocho_comprimento_cm",
        "cocho_largura_cm",
        "cocho_altura_cm",
    ):
        valor = getattr(meta, campo)
        assert casas_decimais(valor) <= 4, f"{campo}={valor} passou de 4 casas decimais"

    assert meta.focus_score == 123.4568
    assert meta.tipo_alimento_densidade_aparente_kg_l == 0.1235
    assert meta.escala_cm_por_pixel == 0.6733
    assert meta.cocho_area_cm2 == 6800.6667
