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

export interface CaptureFormData {
  pesoKg: string; // string no formulário (aceita vírgula/ponto), convertido antes do envio
  tipoAlimento?: string;
  cochoId?: string;
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

export type UploadPhase =
  | "idle"
  | "enviando"
  | "processando"
  | "concluido"
  | "erro";
