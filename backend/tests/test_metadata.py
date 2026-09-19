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


def test_metadata_campos_realmente_opcionais_podem_ser_none():
    # tipo_alimento/observacoes/recorded_at/operador continuam opcionais — só
    # o snapshot do cocho (ver `_COCHO_KWARGS`) deixou de ser.
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
