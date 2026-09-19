"""Modelos de dados (Pydantic) usados pela API e pelos serviços internos."""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.config import get_settings


class SplitType(str, Enum):
    train = "train"
    valid = "valid"
    test = "test"


class FrameStatus(str, Enum):
    aprovado = "aprovado"
    rejeitado_desfoque = "rejeitado_desfoque"
    rejeitado_cocho_incompleto = "rejeitado_cocho_incompleto"
    falha_upload = "falha_upload"


class CaptureFormInput(BaseModel):
    """Campos de formulário recebidos em multipart/form-data em POST /api/captures."""

    peso_kg: float = Field(..., description="Peso real do alimento no cocho, em kg.")
    tipo_alimento: str | None = Field(default=None, max_length=120)
    # Snapshot das medidas do cocho selecionado no aparelho no momento da
    # gravação (ver CochosScreen.tsx no app) — obrigatório desde que o
    # cadastro de cochos passou a existir. Embutido diretamente aqui (em vez
    # de só uma referência a `cocho_id` resolvida depois, contra um registro
    # sincronizado à parte) de propósito: garante que nenhum frame seja
    # processado sem as medidas do cocho, mesmo que a sincronização do
    # cadastro do cocho (ver `services/cocho_registry.py`) atrase, falhe ou
    # chegue fora de ordem.
    cocho_id: str = Field(..., max_length=120, description="Identificador interno do cocho, gerado no aparelho.")
    cocho_nome: str = Field(..., max_length=120, description="Nome do cocho definido pela pessoa (ex.: 'cocho baia 3').")
    cocho_comprimento_cm: float = Field(..., description="Comprimento interno do cocho, em cm.")
    cocho_largura_cm: float = Field(..., description="Largura interna do cocho, em cm.")
    cocho_altura_cm: float = Field(
        ...,
        description="Altura do fundo até o ponto mais alto que o alimento alcançaria com o cocho cheio, em cm.",
    )
    # Separado de `cocho_id` de propósito: o id é um identificador interno
    # gerado no aparelho, sem significado nenhum fora do app; este campo é um
    # rótulo livre (ex.: "2026") pra poder comparar desempenho entre cochos
    # depois, inclusive entre o cocho atual e o cocho fisicamente diferente
    # do próximo experimento (ver decisoes-anotacao.md). Também vira tag no
    # Roboflow (ver `services/roboflow_client.py`).
    cocho_experimento: str = Field(
        ..., max_length=120, description="Rótulo do experimento/ano ao qual este cocho pertence (ex.: '2026')."
    )
    observacoes: str | None = Field(default=None, max_length=1000)
    operador: str | None = Field(
        default=None,
        max_length=120,
        description="Nome de quem gravou, quando configurado no aparelho.",
    )
    recorded_at: int | None = Field(
        default=None,
        description=(
            "Horário real de gravação do vídeo, epoch ms, quando o app conseguiu "
            "descobrir (expo-media-library ou data do arquivo). Opcional: ausente em "
            "capturas de versões antigas do app ou quando nenhuma das duas fontes "
            "funcionou — nesses casos o horário de recebimento do upload é o que fica."
        ),
    )
    origem: Literal["camera", "galeria"] = Field(
        default="galeria",
        description=(
            "De onde o vídeo veio: 'camera' quando gravado na hora pela câmera do "
            "próprio app (duração fixa, ver RECORDING_DURATION_S em config.py), "
            "'galeria' quando selecionado de um vídeo já existente no aparelho "
            "(duração livre, MIN/MAX_VIDEO_DURATION_S). Default 'galeria' por "
            "compatibilidade com versão do app anterior a este campo existir, que "
            "só tinha esse caminho."
        ),
    )

    @field_validator("recorded_at")
    @classmethod
    def validate_recorded_at(cls, v: int | None) -> int | None:
        if v is None:
            return None
        if v <= 0:
            # Claramente inválido (ex.: relógio do aparelho zerado) — melhor
            # descartar do que guardar um valor sem sentido no Roboflow.
            return None
        return v

    @field_validator("peso_kg")
    @classmethod
    def validate_peso_kg(cls, v: float) -> float:
        settings = get_settings()
        if v is None:
            raise ValueError("peso_kg é obrigatório.")
        if v != v:  # NaN check
            raise ValueError("peso_kg inválido (NaN).")
        if v < settings.MIN_PESO_KG:
            raise ValueError(
                f"peso_kg deve ser maior ou igual a {settings.MIN_PESO_KG} kg."
            )
        if v > settings.MAX_PESO_KG:
            raise ValueError(
                f"peso_kg deve ser menor ou igual a {settings.MAX_PESO_KG} kg."
            )
        return round(float(v), 3)

    @field_validator("tipo_alimento", "observacoes", "operador", mode="before")
    @classmethod
    def blank_to_none(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None

    @field_validator("cocho_id", "cocho_nome", "cocho_experimento")
    @classmethod
    def validate_cocho_obrigatorio(cls, v: str, info) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError(f"{info.field_name} é obrigatório.")
        return v

    @field_validator("cocho_comprimento_cm", "cocho_largura_cm", "cocho_altura_cm")
    @classmethod
    def validate_cocho_dimensao(cls, v: float, info) -> float:
        settings = get_settings()
        if v is None or v != v:  # NaN check
            raise ValueError(f"{info.field_name} inválido.")
        if v < settings.MIN_COCHO_DIMENSAO_CM:
            raise ValueError(f"{info.field_name} deve ser maior ou igual a {settings.MIN_COCHO_DIMENSAO_CM} cm.")
        if v > settings.MAX_COCHO_DIMENSAO_CM:
            raise ValueError(f"{info.field_name} deve ser menor ou igual a {settings.MAX_COCHO_DIMENSAO_CM} cm.")
        return round(float(v), 2)


class FrameMetadata(BaseModel):
    """
    Metadados enviados ao Roboflow junto de cada frame aprovado, como JSON.

    Mantém-se peso_kg, video_id e split IGUAIS para todos os frames do mesmo vídeo.
    """

    peso_kg: float
    video_id: str
    frame_time_ms: int
    focus_score: float
    cocho_completo: bool
    tipo_alimento: str | None = None
    # Snapshot do cocho no momento da captura — ver comentário em
    # `CaptureFormInput` acima. Sempre presente: nenhum frame chega até aqui
    # sem essas medidas.
    cocho_id: str
    cocho_nome: str
    cocho_comprimento_cm: float
    cocho_largura_cm: float
    cocho_altura_cm: float
    # Separado de `cocho_id` — ver comentário em `CaptureFormInput` acima.
    cocho_experimento: str
    # Medidos a partir da segmentação do modelo de validação de cocho (ver
    # `services/scale_calculator.py`), não vêm do app nem da pessoa. `None`
    # quando a geometria não veio da detecção (ex.: TROUGH_VALIDATOR=mock, ou
    # as duas extremidades detectadas ficaram próximas demais pra confiar).
    escala_cm_por_pixel: float | None = None
    cocho_area_cm2: float | None = None
    observacoes: str | None = None
    recorded_at: int | None = None
    operador: str | None = None

    def to_json_dict(self) -> dict:
        return self.model_dump(mode="json", exclude_none=False)


class FrameResult(BaseModel):
    frame_index: int
    frame_time_ms: int
    focus_score: float
    cocho_completo: bool
    status: FrameStatus
    roboflow_image_id: str | None = None
    motivo_rejeicao: str | None = None


class CaptureResponse(BaseModel):
    capture_id: str
    video_id: str
    split: SplitType
    peso_kg: float
    total_candidatos: int
    total_aprovados: int
    total_rejeitados_desfoque: int
    total_rejeitados_cocho_incompleto: int
    total_falhas_upload: int
    frames: list[FrameResult]
    idempotente_reprocessado: bool = False


class ErrorResponse(BaseModel):
    detail: str


class ChunkedUploadInitResponse(BaseModel):
    """Resposta de POST /api/captures/init — ver `services/chunked_upload_service.py`."""

    status: Literal["already_processed", "in_progress"]
    # Índices de blocos que o backend já tem, pra o app pular no reenvio.
    # Vazio numa sessão nova ou quando `status == "already_processed"`.
    received_chunks: list[int] = Field(default_factory=list)
    # Preenchido só quando `status == "already_processed"` — o app pode usar
    # direto, sem enviar nenhum bloco.
    result: CaptureResponse | None = None


class ChunkAckResponse(BaseModel):
    """Resposta de cada POST /api/captures/{capture_id}/chunks/{chunk_index}."""

    received_chunks_count: int
    total_chunks: int


class CochoInput(BaseModel):
    """
    Corpo de POST /api/cochos — registro auxiliar de um cocho, feito uma vez
    no aparelho (ver CochosScreen.tsx) e reaproveitado em várias capturas.

    Este registro é só para listar/reaproveitar cochos entre aparelhos: a
    medida que de fato vale para o processamento de cada vídeo vai embutida
    (snapshot) em `CaptureFormInput`, então nenhuma captura fica bloqueada
    mesmo que o registro de um cocho nunca chegue a sincronizar aqui.
    """

    cocho_id: str = Field(..., max_length=120, description="UUID gerado no aparelho.")
    nome: str = Field(..., max_length=120)
    comprimento_cm: float
    largura_cm: float
    altura_cm: float
    # Separado de `cocho_id` — ver comentário em `CaptureFormInput.cocho_experimento`.
    experimento: str = Field(..., max_length=120, description="Rótulo do experimento/ano ao qual este cocho pertence.")

    @field_validator("cocho_id", "nome", "experimento")
    @classmethod
    def validate_obrigatorio(cls, v: str, info) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError(f"{info.field_name} é obrigatório.")
        return v

    @field_validator("comprimento_cm", "largura_cm", "altura_cm")
    @classmethod
    def validate_dimensao(cls, v: float, info) -> float:
        settings = get_settings()
        if v is None or v != v:  # NaN check
            raise ValueError(f"{info.field_name} inválido.")
        if v < settings.MIN_COCHO_DIMENSAO_CM:
            raise ValueError(f"{info.field_name} deve ser maior ou igual a {settings.MIN_COCHO_DIMENSAO_CM} cm.")
        if v > settings.MAX_COCHO_DIMENSAO_CM:
            raise ValueError(f"{info.field_name} deve ser menor ou igual a {settings.MAX_COCHO_DIMENSAO_CM} cm.")
        return round(float(v), 2)


class CochoResponse(BaseModel):
    cocho_id: str
    nome: str
    comprimento_cm: float
    largura_cm: float
    altura_cm: float
    experimento: str
    criado_em: int
