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
}

export interface SelectedVideo {
  uri: string;
  durationMs: number;
  sizeBytes: number;
  fileName: string;
  mimeType: string;
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
