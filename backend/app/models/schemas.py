"""Modelos de dados (Pydantic) usados pela API e pelos serviços internos."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from enum import Enum
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, field_validator, model_validator

from app.config import get_settings

# Fuso horário usado só pra exibição (ver `FrameMetadata.horario_gravacao`
# abaixo) — a própria Lucas/equipe opera em horário de Brasília. `recorded_at`
# continua guardado em epoch ms (UTC), sem depender de fuso nenhum; só a
# versão "HH:MM" legível é convertida pra esse fuso.
_FUSO_HORARIO_EXIBICAO = ZoneInfo("America/Sao_Paulo")


def _round_decimal(v: float, casas: int) -> float:
    """
    Arredonda `v` pra `casas` casas decimais de forma exata, evitando a
    armadilha clássica do `round()` do Python com números binários de ponto
    flutuante: `round(2.675, 2)` dá `2.67`, não `2.68`, porque `2.675` não tem
    representação binária exata (o float mais próximo é ligeiramente menor
    que 2.675). Passar primeiro por `str(v)` — a representação decimal mais
    curta que reproduz exatamente aquele float — antes de converter pra
    `Decimal` evita herdar esse erro de representação; `ROUND_HALF_UP`
    arredonda 0.5 sempre pra cima, o comportamento que qualquer pessoa lendo
    o número esperaria (o `round()` do Python, por padrão, arredonda 0.5 pro
    par mais próximo, o que também surpreende quem não conhece essa regra).
    """
    quantizador = Decimal(1).scaleb(-casas)
    return float(Decimal(str(v)).quantize(quantizador, rounding=ROUND_HALF_UP))


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
    # Snapshot do tipo de alimento selecionado no aparelho (ver
    # TiposAlimentoScreen.tsx) — mesma lógica do snapshot de cocho logo
    # abaixo: obrigatório, embutido direto aqui (não só uma referência a
    # `tipo_alimento_id` resolvida depois contra o registro sincronizado à
    # parte), pra nenhuma captura ficar bloqueada por um cadastro que atrase,
    # falhe ou chegue fora de ordem (ver `services/tipo_alimento_registry.py`).
    tipo_alimento_id: str = Field(..., max_length=120, description="Identificador interno do tipo de alimento, gerado no aparelho.")
    tipo_alimento_nome: str = Field(..., max_length=120, description="Nome do tipo de alimento (ex.: 'Silagem', 'Ração').")
    tipo_alimento_densidade_aparente_kg_l: float = Field(
        ..., description="Densidade aparente do alimento, em Kg/L (frasco de volume conhecido, cheio e pesado)."
    )
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
        """
        `recorded_at` vem de uma fonte imprecisa por natureza (ver comentário
        no campo acima: MediaLibrary ou data de modificação do arquivo — a
        segunda em especial pode refletir quando o arquivo foi COPIADO/
        IMPORTADO, não quando o vídeo foi de fato gravado). Em vez de confiar
        em qualquer valor só porque é um número positivo, valida contra uma
        janela de plausibilidade (`RECORDED_AT_MAX_ANOS_PASSADO`/
        `RECORDED_AT_TOLERANCIA_FUTURO_MIN` em `config.py`) e descarta
        (`None`) o que estiver fora dela — nunca levanta erro por causa
        disso: um horário de gravação ruim não deve travar a captura inteira,
        só deixar de ser guardado.
        """
        if v is None:
            return None
        if v <= 0:
            # Claramente inválido (ex.: relógio do aparelho zerado) — melhor
            # descartar do que guardar um valor sem sentido no Roboflow.
            return None
        settings = get_settings()
        agora_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        tolerancia_futuro_ms = settings.RECORDED_AT_TOLERANCIA_FUTURO_MIN * 60 * 1000
        limite_passado_ms = agora_ms - settings.RECORDED_AT_MAX_ANOS_PASSADO * 365 * 24 * 60 * 60 * 1000
        if v > agora_ms + tolerancia_futuro_ms:
            # No futuro além da tolerância — relógio do aparelho adiantado,
            # ou a fonte do horário não é confiável.
            return None
        if v < limite_passado_ms:
            # Longe demais no passado pra ser a gravação real — quase certo
            # que é a data de modificação de um arquivo reaproveitado/copiado
            # de outro lugar (galeria), não a gravação em si.
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
        return _round_decimal(float(v), 3)

    @field_validator("observacoes", "operador", mode="before")
    @classmethod
    def blank_to_none(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None

    @field_validator("cocho_id", "cocho_nome", "cocho_experimento", "tipo_alimento_id", "tipo_alimento_nome")
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
        return _round_decimal(float(v), 2)

    @field_validator("tipo_alimento_densidade_aparente_kg_l")
    @classmethod
    def validate_densidade_aparente(cls, v: float) -> float:
        settings = get_settings()
        if v is None or v != v:  # NaN check
            raise ValueError("tipo_alimento_densidade_aparente_kg_l inválida.")
        if v < settings.MIN_DENSIDADE_APARENTE_KG_L:
            raise ValueError(
                f"tipo_alimento_densidade_aparente_kg_l deve ser maior ou igual a {settings.MIN_DENSIDADE_APARENTE_KG_L} Kg/L."
            )
        if v > settings.MAX_DENSIDADE_APARENTE_KG_L:
            raise ValueError(
                f"tipo_alimento_densidade_aparente_kg_l deve ser menor ou igual a {settings.MAX_DENSIDADE_APARENTE_KG_L} Kg/L."
            )
        return _round_decimal(float(v), 3)


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
    # Nome do tipo de alimento (vira tag no Roboflow, ver
    # `services/roboflow_client.py`) — sempre presente desde que o cadastro
    # de tipo de alimento passou a ser obrigatório (ver `CaptureFormInput`
    # acima); `None` só em capturas antigas re-processadas de antes disso.
    tipo_alimento: str | None = None
    # Snapshot da densidade aparente do tipo de alimento no momento da
    # captura (mesmo motivo do snapshot de cocho abaixo: trava o valor aqui
    # pra não mudar retroativamente se o cadastro do tipo de alimento for
    # editado depois). Guardado hoje só pra manter a opção de usá-la no
    # futuro — seja como feature da regressão, seja num cálculo por
    # peso = volume × densidade; nenhum dos dois está implementado ainda.
    # `None` só em capturas antigas re-processadas de antes desse campo.
    tipo_alimento_densidade_aparente_kg_l: float | None = None
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
    # Ver `CaptureFormInput.validate_recorded_at`: já chega aqui filtrado por
    # uma janela de plausibilidade — se não passou nela, já é `None` antes de
    # chegar em `FrameMetadata`, nunca um valor claramente errado.
    recorded_at: int | None = None
    # Derivado automaticamente de `recorded_at` pelo model_validator abaixo —
    # nunca é passado diretamente por quem constrói `FrameMetadata`, pra não
    # existir risco de os dois ficarem incoerentes entre si. Formato "HH:MM"
    # (fuso America/Sao_Paulo — ver `_FUSO_HORARIO_EXIBICAO` no topo do
    # arquivo), pensado pra ficar legível de relance no painel de Metadata do
    # Roboflow, onde `recorded_at` (epoch ms) não diz nada a olho nu; o
    # Roboflow aceita metadata em texto normalmente (não só números), então
    # não há problema em subir como string. `None` sempre que `recorded_at`
    # também for `None` (ausente, ou descartado por implausível).
    horario_gravacao: str | None = None
    operador: str | None = None

    @field_validator(
        "peso_kg",
        "focus_score",
        "tipo_alimento_densidade_aparente_kg_l",
        "cocho_comprimento_cm",
        "cocho_largura_cm",
        "cocho_altura_cm",
        "escala_cm_por_pixel",
        "cocho_area_cm2",
    )
    @classmethod
    def _limitar_a_quatro_casas_decimais(cls, v: float | None) -> float | None:
        """
        Teto único de 4 casas decimais pra TODO número que vai como metadata
        ao Roboflow — inclusive `focus_score`, `escala_cm_por_pixel` e
        `cocho_area_cm2`, que antes desta revisão saíam sem nenhum
        arredondamento (variância do Laplaciano e conversões geométricas em
        ponto flutuante têm, na prática, muito mais dígitos do que qualquer
        precisão real por trás deles). Os campos que já chegam aqui
        pré-arredondados por `CaptureFormInput` (peso_kg a 3 casas, dimensões
        de cocho a 2, densidade a 3) não mudam de valor — só ganham a garantia
        de nunca passar de 4, não importa quem construiu este `FrameMetadata`.
        """
        if v is None:
            return None
        return _round_decimal(v, 4)

    @model_validator(mode="after")
    def _derivar_horario_gravacao(self) -> "FrameMetadata":
        if self.recorded_at is not None:
            momento = datetime.fromtimestamp(self.recorded_at / 1000, tz=_FUSO_HORARIO_EXIBICAO)
            self.horario_gravacao = momento.strftime("%H:%M")
        return self

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
        return _round_decimal(float(v), 2)


class CochoResponse(BaseModel):
    cocho_id: str
    nome: str
    comprimento_cm: float
    largura_cm: float
    altura_cm: float
    experimento: str
    criado_em: int


class TipoAlimentoInput(BaseModel):
    """
    Corpo de POST /api/tipos-alimento — registro auxiliar de um tipo de
    alimento, feito uma vez no aparelho (ver TiposAlimentoScreen.tsx) e
    reaproveitado em várias capturas. Mesma lógica de `CochoInput` acima:
    este registro é só para listar/reaproveitar tipos entre aparelhos, a
    medida que de fato vale pro processamento de cada vídeo vai embutida
    (snapshot) em `CaptureFormInput`, então nenhuma captura fica bloqueada
    mesmo que o registro de um tipo de alimento nunca chegue a sincronizar
    aqui.
    """

    tipo_alimento_id: str = Field(..., max_length=120, description="UUID gerado no aparelho.")
    nome: str = Field(..., max_length=120)
    densidade_aparente_kg_l: float = Field(
        ..., description="Densidade aparente do alimento, em Kg/L (frasco de volume conhecido, cheio e pesado)."
    )

    @field_validator("tipo_alimento_id", "nome")
    @classmethod
    def validate_obrigatorio(cls, v: str, info) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError(f"{info.field_name} é obrigatório.")
        return v

    @field_validator("densidade_aparente_kg_l")
    @classmethod
    def validate_densidade(cls, v: float) -> float:
        settings = get_settings()
        if v is None or v != v:  # NaN check
            raise ValueError("densidade_aparente_kg_l inválida.")
        if v < settings.MIN_DENSIDADE_APARENTE_KG_L:
            raise ValueError(f"densidade_aparente_kg_l deve ser maior ou igual a {settings.MIN_DENSIDADE_APARENTE_KG_L} Kg/L.")
        if v > settings.MAX_DENSIDADE_APARENTE_KG_L:
            raise ValueError(f"densidade_aparente_kg_l deve ser menor ou igual a {settings.MAX_DENSIDADE_APARENTE_KG_L} Kg/L.")
        return _round_decimal(float(v), 3)


class TipoAlimentoResponse(BaseModel):
    tipo_alimento_id: str
    nome: str
    densidade_aparente_kg_l: float
    criado_em: int
