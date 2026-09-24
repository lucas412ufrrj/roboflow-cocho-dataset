"""
Configurações centrais da aplicação.

Todos os segredos (em especial ROBOFLOW_API_KEY) são carregados exclusivamente
de variáveis de ambiente no backend. NUNCA exponha `ROBOFLOW_API_KEY` em
respostas de API, logs ou para o aplicativo móvel.
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Aplicação ---
    APP_NAME: str = "roboflow-cocho-capture-backend"
    APP_ENV: Literal["development", "staging", "production", "test"] = "development"
    LOG_LEVEL: str = "INFO"

    # Versão nativa (campo "version" do app.json do app móvel) mais recente
    # que exige uma build/instalação nova — não uma atualização OTA (`eas
    # update`), que já chega sozinha. Atualize este valor manualmente TODA
    # VEZ que gerar uma build nova com `eas build` (ao mesmo tempo em que
    # bumpar o "version" do app.json). O app compara isso com a própria
    # versão instalada (`Application.nativeApplicationVersion`) na abertura
    # e mostra um aviso pra quem ainda estiver numa build mais antiga — ver
    # `mobile/src/services/buildCheck.ts`.
    ULTIMA_VERSAO_NATIVA: str = "1.0.0"

    # --- Autenticação do app móvel no NOSSO backend (nunca no Roboflow) ---
    BACKEND_API_KEY: str = Field(
        default="change-me-backend-api-key",
        description="Chave usada pelo app móvel para autenticar no backend.",
    )

    # --- Autenticação de escrita no registro de cochos ---
    # Segredo separado de BACKEND_API_KEY: todo o app conhece o BACKEND_API_KEY
    # (senão ninguém conseguiria nem listar/enviar captura), mas só quem
    # cadastra/edita/exclui cocho deve ter este aqui — ver
    # `verify_admin_api_key` em `core/security.py` e `mobile/src/screens/
    # SobreScreen.tsx` (onde essa chave é digitada e guardada localmente no
    # aparelho de quem administra). É uma trava simples pra evitar edição
    # acidental pela equipe em campo, não proteção contra alguém decidido a
    # extrair a chave do próprio app — proteção de verdade exigiria login por
    # pessoa validado no servidor, planejado como evolução futura.
    ADMIN_API_KEY: str = Field(
        default="change-me-admin-api-key",
        description="Chave exigida para cadastrar, editar ou excluir um cocho.",
    )

    # --- Rate limiting ---
    RATE_LIMIT_CAPTURES: str = "10/minute"
    # Bem mais generoso que RATE_LIMIT_CAPTURES: um único vídeo grande vira
    # dezenas de requisições pequenas (ver `app/services/chunked_upload_service.py`).
    RATE_LIMIT_CHUNKS: str = "600/minute"

    # --- Upload / vídeo ---
    MAX_VIDEO_SIZE_MB: float = 150.0
    # Vídeo selecionado da galeria (origem="galeria"): intervalo livre, como sempre foi.
    MIN_VIDEO_DURATION_S: float = 7.0
    MAX_VIDEO_DURATION_S: float = 10.0
    # Vídeo gravado na hora pela câmera do app (origem="camera", ver
    # `mobile/src/screens/RecordVideoScreen.tsx"): duração fixa, decidida pelo
    # app, não pela pessoa gravando. TEM que bater com `RECORDING_DURATION_S`
    # e `RECORDING_TOLERANCE_S` em `mobile/src/utils/video.ts` — os dois lados
    # validam a mesma regra de forma independente, não há um valor só
    # compartilhado entre app e backend.
    RECORDING_DURATION_S: float = 8.5
    RECORDING_DURATION_TOLERANCE_S: float = 0.3
    ALLOWED_VIDEO_MIME_TYPES: tuple[str, ...] = (
        "video/mp4",
        "video/quicktime",  # .mov gravado no iOS, será normalizado
        "video/x-matroska",
    )

    # --- Peso ---
    MIN_PESO_KG: float = 0.01
    MAX_PESO_KG: float = 2000.0

    # --- Cocho (registrado uma vez no aparelho, snapshot embutido em cada
    # captura — ver CaptureFormInput.cocho_* em models/schemas.py) ---
    MIN_COCHO_DIMENSAO_CM: float = 5.0
    MAX_COCHO_DIMENSAO_CM: float = 2000.0

    # --- Tipo de alimento (registrado uma vez no aparelho, mesma lógica do
    # cocho: só quem tem ADMIN_API_KEY cadastra/edita/exclui, snapshot
    # embutido em cada captura — ver CaptureFormInput.tipo_alimento_*) ---
    MIN_DENSIDADE_APARENTE_KG_L: float = 0.05
    MAX_DENSIDADE_APARENTE_KG_L: float = 3.0

    # --- Plausibilidade de `recorded_at` (horário real de gravação do vídeo,
    # ver CaptureFormInput.recorded_at) — a fonte no aparelho (MediaLibrary ou
    # data de modificação do arquivo) às vezes devolve um valor tecnicamente
    # válido (> 0) mas sem relação real com a gravação (ex.: data de
    # importação de um vídeo copiado de outro lugar, ou relógio do aparelho
    # desconfigurado). Fora dessa janela, o valor é descartado (`None`) em vez
    # de guardado errado — ver `validate_recorded_at`. ---
    # Quantos anos no passado, a partir de agora, ainda é considerado
    # plausível. Generoso de propósito: só existe pra pegar casos claramente
    # errados (arquivo copiado/reaproveitado de muito tempo atrás), não pra
    # apertar precisão.
    RECORDED_AT_MAX_ANOS_PASSADO: int = 3
    # Quantos minutos no futuro (a partir de agora, hora do servidor) ainda é
    # tolerado — cobre diferença de fuso/relógio não perfeitamente sincronizado
    # entre o aparelho e o servidor, sem aceitar um valor claramente futuro.
    RECORDED_AT_TOLERANCIA_FUTURO_MIN: int = 1440

    # --- Extração de frames ---
    FRAMES_PER_SECOND: float = 3.0
    FOCUS_SCORE_THRESHOLD: float = 100.0  # variância do Laplaciano

    # --- ffmpeg (normalização/reencode de vídeo) ---
    # O ffmpeg roda como subprocesso do MESMO container, então a memória dele
    # conta junto no teto de 512MB do Render — foi o que derrubou o serviço
    # três vezes em 22/09, sempre logo depois de "normalização NECESSÁRIA"
    # num vídeo HEVC 1080p vindo da galeria (ver decisão registrada no
    # projeto Claude).
    #
    # Threads: sem `-threads`, o ffmpeg usa "auto" = número de CPUs que ele
    # ENXERGA, que no Render é o do host inteiro, não a fatia do plano. Cada
    # thread do decoder e do encoder aloca seus próprios buffers de quadro,
    # então "auto" multiplica o consumo por algo que não temos controle
    # nenhum. 1 thread é mais lento e previsível; o vídeo tem ~9 s, dá tempo
    # de sobra dentro do timeout do app (60 s, ver `TIMEOUT_*` em `client.ts`).
    FFMPEG_THREADS: int = 1
    # Quantos reencodes podem rodar ao mesmo tempo neste processo. Com 1, uma
    # equipe inteira enviando junto enfileira em vez de somar N ffmpegs na
    # memória ao mesmo tempo (ver `_SEMAFORO_FFMPEG` em `ffmpeg_utils.py`).
    FFMPEG_MAX_CONCORRENTES: int = 1
    # Teto de resolução ao normalizar. 1080p multiplica o custo de memória do
    # encoder sem ganho pro pipeline: os quadros vão pro Roboflow e o modelo
    # trabalha em resolução bem menor. Também alinha o vídeo de galeria com o
    # de câmera, que já era cortado em 1280x720 (ver
    # `reencode_for_camera_origin`). Suba se algum dia precisar de mais
    # detalhe no quadro — e acompanhe a memória se fizer isso.
    NORMALIZACAO_MAX_WIDTH: int = 1280
    NORMALIZACAO_MAX_HEIGHT: int = 720

    # --- Armazenamento temporário (vídeo em processamento) ---
    # De propósito EFÊMERO: cada arquivo aqui é apagado por `_cleanup` no fim
    # do processamento da própria captura (ver `capture_service.py`). No
    # Render, este caminho vive no disco do container e é apagado a cada
    # deploy/restart — o que é exatamente certo pra este uso, mas SERIA
    # ERRADO pra dado que precisa sobreviver a um deploy (ver
    # PERSISTENT_DATA_PATH abaixo, que é o caso oposto).
    STORAGE_BACKEND: Literal["local", "s3"] = "local"
    LOCAL_STORAGE_PATH: str = "./tmp_storage"

    # S3 (usado somente quando STORAGE_BACKEND=s3)
    S3_BUCKET: str = ""
    S3_REGION: str = "us-east-1"
    S3_ENDPOINT_URL: str | None = None
    AWS_ACCESS_KEY_ID: str | None = None
    AWS_SECRET_ACCESS_KEY: str | None = None

    # --- Armazenamento DURÁVEL (registro de cochos, idempotência) ---
    # Ao contrário de LOCAL_STORAGE_PATH acima, isto precisa sobreviver a um
    # deploy/restart do backend — é onde `FileCochoRegistry`
    # (`services/cocho_registry.py`) e `FileIdempotencyStore`
    # (`services/idempotency.py`) gravam. Rodando local (`./persistent_data`
    # já basta, o disco da própria máquina já é durável). No Render, um
    # caminho comum a um container recém-criado a cada deploy NÃO sobrevive
    # sozinho — é preciso adicionar um Persistent Disk ao serviço
    # (Render -> serviço -> Disks -> Add Disk, escolher um mount path, ex.:
    # `/var/data`) e então configurar esta variável de ambiente com esse
    # MESMO mount path. Sem isso, cada deploy reseta o registro de cochos
    # para vazio (foi o que apagou um cocho recém-cadastrado após um deploy
    # em 2026-09-19 — ver decisão registrada no projeto Claude).
    PERSISTENT_DATA_PATH: str = "./persistent_data"

    # --- Backend do registro de cochos ---
    # file: grava em PERSISTENT_DATA_PATH acima — só é de fato durável se
    # esse caminho estiver num Persistent Disk de verdade (pago no Render).
    # github: grava um JSON dentro do próprio repositório git via API REST
    # do GitHub (Contents API) — alternativa gratuita, nunca expira/pausa
    # (ao contrário de bancos free-tier como MongoDB Atlas M0 ou Upstash),
    # escolhida em 2026-09-19 pra resolver o mesmo problema sem custo. Ver
    # `services/cocho_registry.GitHubCochoRegistry` e decisão registrada no
    # projeto Claude. Não muda nada em `idempotency.py` (continua em
    # PERSISTENT_DATA_PATH) — a idempotência de upload não sofreu o mesmo
    # incidente e tem impacto bem menor se resetar.
    COCHO_REGISTRY_BACKEND: Literal["file", "github"] = "file"

    # Preencha somente se COCHO_REGISTRY_BACKEND=github.
    # Token de acesso pessoal (fine-grained) do GitHub, com permissão
    # "Contents: Read and write" restrita a este único repositório. NUNCA
    # exponha isso em log, resposta de API ou para o app móvel.
    GITHUB_TOKEN: str = ""
    # Formato "usuario/repositorio", ex.: "lucasdagui413/roboflow-cocho-dataset".
    GITHUB_REPO: str = ""
    GITHUB_COCHOS_PATH: str = "backend/_data/cochos.json"
    GITHUB_BRANCH: str = "main"

    # --- Backend do registro de tipos de alimento ---
    # Mesma lógica de COCHO_REGISTRY_BACKEND acima, registro separado
    # (arquivo/campo diferente), reaproveitando GITHUB_TOKEN/GITHUB_REPO/
    # GITHUB_BRANCH já configurados acima quando COCHO_REGISTRY_BACKEND (ou
    # este) usar "github".
    TIPO_ALIMENTO_REGISTRY_BACKEND: Literal["file", "github"] = "file"
    GITHUB_TIPOS_ALIMENTO_PATH: str = "backend/_data/tipos_alimento.json"

    # --- Roboflow (workspace/projeto NÃO são segredos, a chave é) ---
    ROBOFLOW_API_KEY: str = Field(
        default="",
        description="Chave privada do Roboflow. Somente no backend. NUNCA logar.",
    )
    ROBOFLOW_WORKSPACE: str = "lucas-da-guia-costa"
    ROBOFLOW_PROJECT: str = "peso-de-alimento-no-cocho"
    ROBOFLOW_UPLOAD_BASE_URL: str = "https://api.roboflow.com"
    ROBOFLOW_UPLOAD_TIMEOUT_S: float = 30.0
    ROBOFLOW_UPLOAD_MAX_RETRIES: int = 4

    # --- Validador de cocho ---
    # ROBOFLOW_UPLOAD_BASE_URL (acima) é a API de gerenciamento de dataset
    # (usada por roboflow_client.py para SUBIR frames aprovados).
    # ROBOFLOW_INFERENCE_BASE_URL é a API de inferência hospedada (usada
    # aqui para CONSULTAR o modelo treinado) — são hosts diferentes no
    # Roboflow, não reaproveite um pelo outro.
    ROBOFLOW_INFERENCE_BASE_URL: str = "https://detect.roboflow.com"
    TROUGH_VALIDATOR: Literal["mock", "roboflow"] = "mock"
    TROUGH_VALIDATOR_MOCK_ALWAYS_VALID: bool = True
    TROUGH_VALIDATOR_MOCK_CONFIDENCE: float = 0.95
    # Formato "projeto/versao", ex: "reconhecimento-de-cocho/13".
    ROBOFLOW_TROUGH_MODEL_ID: str = ""
    # Chave do workspace onde o modelo de detecção vive (pode ser diferente
    # do workspace de upload do dataset de peso, ex. lucass-workspace-mmecb
    # vs. lucas-da-guia-costa). Se vazia, cai para ROBOFLOW_API_KEY — só
    # deixe vazia se os dois projetos estiverem de fato na mesma conta.
    ROBOFLOW_TROUGH_API_KEY: str = ""
    ROBOFLOW_TROUGH_CONFIDENCE_THRESHOLD: float = 0.5

    # --- Modelo 1: reenvio de frames "cocho incompleto" como dado bruto ---
    # Frames reprovados por TroughValidator (acima) hoje eram só descartados.
    # Com isso ligado, cada captura manda uma FRAÇÃO desses frames — SEM
    # anotação — pro dataset do próprio Modelo 1 (ROBOFLOW_TROUGH_UPLOAD_PROJECT),
    # fechando o ciclo entre captura real de campo e os lotes de reanotação
    # manual que o Lucas já faz a cada cocho novo (ver decisão registrada no
    # projeto Claude em 19/09/2026). Usa a mesma chave de
    # ROBOFLOW_TROUGH_API_KEY (fallback ROBOFLOW_API_KEY) já usada acima para
    # inferência — mas upload de dataset exige permissão de ESCRITA nesse
    # projeto, que pode não vir junto com uma chave só de leitura/inferência.
    # Por isso desligado por padrão: só ligar depois de confirmar que a chave
    # configurada tem essa permissão em `reconhecimento-de-cocho`.
    ENVIAR_COCHO_INCOMPLETO_MODELO_1: bool = False
    ROBOFLOW_TROUGH_UPLOAD_PROJECT: str = "reconhecimento-de-cocho"
    # Fração dos frames "cocho incompleto" de cada captura enviada ao Modelo
    # 1 (0.0 a 1.0). Antes disso era um teto fixo de frames por captura, que
    # limitava a poucos exemplos mesmo em vídeos longos — mas o modelo de
    # detecção vem tendo dificuldade justamente com vídeos gravados por
    # câmeras diferentes da do app, e o objetivo agora é dar mais volume de
    # dado pra ele aprender com essas condições, mesmo que as imagens saiam
    # parecidas entre si (ver decisão registrada no projeto Claude em
    # 24/09/2026). Selecionado por um acumulador (ver
    # `CaptureService.process_capture`), não por sorteio: com 0.5 (padrão),
    # manda o 2º, 4º, 6º... frame incompleto, distribuindo a metade
    # escolhida de forma uniforme ao longo do vídeo em vez de só os
    # primeiros ou só os últimos.
    ROBOFLOW_TROUGH_FRACAO_FRAMES_INCOMPLETOS: float = 0.5

    @field_validator("ROBOFLOW_API_KEY")
    @classmethod
    def _warn_empty_key_in_prod(cls, v: str, info) -> str:
        # Não lança erro aqui (para permitir testes sem a chave), mas o
        # RoboflowTroughValidator/RoboflowClient reais devem validar antes de operar.
        return v


@lru_cache
def get_settings() -> Settings:
    return Settings()
