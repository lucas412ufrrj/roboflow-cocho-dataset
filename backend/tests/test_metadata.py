from __future__ import annotations

from app.models.schemas import FrameMetadata


def test_metadata_contem_todos_os_campos_exigidos():
    meta = FrameMetadata(
        peso_kg=42.5,
        video_id="video-123",
        frame_time_ms=1500,
        focus_score=210.7,
        cocho_completo=True,
        tipo_alimento="Ração",
        cocho_id="cocho-07",
        observacoes="Teste",
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
        "observacoes",
    }
    assert campos_esperados.issubset(data.keys())
    assert data["peso_kg"] == 42.5
    assert data["video_id"] == "video-123"
    assert data["cocho_completo"] is True


def test_metadata_campos_opcionais_podem_ser_none():
    meta = FrameMetadata(
        peso_kg=10.0,
        video_id="video-abc",
        frame_time_ms=0,
        focus_score=150.0,
        cocho_completo=True,
    )
    data = meta.to_json_dict()
    assert data["tipo_alimento"] is None
    assert data["cocho_id"] is None
    assert data["observacoes"] is None


def test_todos_os_frames_do_mesmo_video_compartilham_video_id_e_peso():
    video_id = "video-xyz"
    peso_kg = 33.0

    frame_a = FrameMetadata(
        peso_kg=peso_kg, video_id=video_id, frame_time_ms=0, focus_score=200.0, cocho_completo=True
    )
    frame_b = FrameMetadata(
        peso_kg=peso_kg, video_id=video_id, frame_time_ms=333, focus_score=180.0, cocho_completo=True
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
    )
    json_str = meta.model_dump_json()
    assert '"peso_kg":5.5' in json_str.replace(" ", "")
