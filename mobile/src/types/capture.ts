/**
 * Tipos compartilhados do fluxo de captura, espelhando os schemas do backend
 * (ver `backend/app/models/schemas.py`).
 */

export type SplitType = "train" | "valid" | "test";

export type FrameStatus =
  | "aprovado"
  | "rejeitado_desfoque"
  | "rejeitado_cocho_incompleto"
  | "falha_upload";

/**
 * Cocho cadastrado no aparelho (ver `services/cochoStorage.ts` e
 * `screens/CochosScreen.tsx`) — selecionado obrigatoriamente antes de
 * gravar. `id` é gerado no aparelho (nunca digitado pela pessoa, só o
 * `nome` é dela), mesmo padrão de `utils/uuid.ts`.
 */
export interface Cocho {
  id: string;
  nome: string;
  comprimentoCm: number;
  larguraCm: number;
  /**
   * Do fundo até o ponto mais alto que o alimento alcançaria com o cocho
   * cheio (lotação máxima) — não necessariamente a borda física do cocho.
   */
  alturaCm: number;
  /**
   * Rótulo livre do experimento/ano a que este cocho pertence (ex.: "2026"),
   * separado do `id` — pra poder comparar desempenho entre cochos depois sem
   * depender do identificador interno gerado no aparelho. Embutido no
   * snapshot de cada captura (`cocho_experimento`) do mesmo jeito que as
   * medidas, e também vira tag no Roboflow (ver `roboflow_client.py`).
   */
  experimento: string;
}

/**
 * Tipo de alimento cadastrado no aparelho (ver
 * `services/tipoAlimentoStorage.ts` e `screens/TiposAlimentoScreen.tsx`) —
 * selecionado obrigatoriamente após o cocho, antes de gravar. Mesmo padrão
 * de `Cocho` acima: `id` gerado no aparelho, nunca digitado pela pessoa.
 */
export interface TipoAlimento {
  id: string;
  nome: string;
  /**
   * Densidade aparente do alimento, em Kg/L — obtida enchendo um frasco de
   * volume conhecido e pesando (ver texto de ajuda em
   * `TiposAlimentoScreen.tsx`). Embutida no snapshot de cada captura do
   * mesmo jeito que as medidas do cocho.
   */
  densidadeAparenteKgL: number;
}

export interface CaptureFormData {
  pesoKg: string; // string no formulário (aceita vírgula/ponto), convertido antes do envio
  /**
   * Snapshot do cocho selecionado antes da gravação — embutido aqui (não só
   * uma referência a um ID resolvida depois) de propósito: garante que a
   * captura nunca fique sem as medidas do cocho, mesmo que o cadastro dele
   * (ver `services/cochoSync.ts`) ainda não tenha sincronizado com o
   * backend. Obrigatório: não existe mais captura sem cocho selecionado.
   */
  cocho: Cocho;
  /**
   * Snapshot do tipo de alimento selecionado antes da gravação — mesma
   * lógica do `cocho` acima (obrigatório, embutido, nunca só uma referência
   * a um ID resolvida depois). Selecionado logo após o cocho, numa tela
   * própria (ver `screens/TiposAlimentoScreen.tsx`), não mais digitado
   * livremente no formulário de captura.
   */
  tipoAlimento: TipoAlimento;
  observacoes?: string;
  /**
   * Nome de quem está gravando, configurado uma vez no Lobby (ver
   * `services/operador.ts`) e anexado automaticamente a cada captura na
   * Prévia — não é um campo editável por captura. `undefined` quando nunca
   * foi configurado no aparelho.
   */
  operador?: string;
}

export interface SelectedVideo {
  uri: string;
  durationMs: number;
  sizeBytes: number;
  fileName: string;
  mimeType: string;
  /**
   * Horário real de gravação (epoch ms), quando dá pra descobrir — via
   * `expo-media-library` (vídeo com `assetId`) ou, na falta disso, a data de
   * modificação do próprio arquivo (ver `RecordVideoScreen.obterHorarioReal`).
   * `undefined` quando nenhuma das duas fontes funcionou; nesse caso o
   * backend usa o horário de recebimento do upload, como já fazia antes.
   */
  recordedAt?: number;
  /**
   * De onde este vídeo veio: "camera" quando gravado na hora pela câmera do
   * próprio app (duração fixa, ver `RECORDING_DURATION_S` em `utils/video.ts`
   * e `RecordVideoScreen.tsx`), "galeria" quando selecionado de um vídeo já
   * existente no aparelho (duração livre entre `MIN_DURATION_S` e
   * `MAX_DURATION_S`). Opcional só por compatibilidade com item de fila
   * salvo por uma versão anterior do app; ausência é tratada como "galeria"
   * em todo lugar que lê este campo, que era o único comportamento antes de
   * ele existir.
   */
  origem?: "camera" | "galeria";
}

export interface FrameResult {
  frame_index: number;
  frame_time_ms: number;
  focus_score: number;
  cocho_completo: boolean;
  status: FrameStatus;
  roboflow_image_id?: string | null;
  motivo_rejeicao?: string | null;
}

export interface CaptureResponse {
  capture_id: string;
  video_id: string;
  split: SplitType;
  peso_kg: number;
  total_candidatos: number;
  total_aprovados: number;
  total_rejeitados_desfoque: number;
  total_rejeitados_cocho_incompleto: number;
  total_falhas_upload: number;
  frames: FrameResult[];
  idempotente_reprocessado: boolean;
}

export interface ApiErrorBody {
  detail: string;
}
