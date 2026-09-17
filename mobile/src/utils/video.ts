export const MIN_DURATION_S = 7;
export const MAX_DURATION_S = 10;

// Vídeo gravado na hora (câmera do app, ver `RecordVideoScreen.tsx`): duração
// fixa, decidida pelo app, não pela pessoa gravando — ela só aperta o botão e
// a gravação para sozinha. `RECORDING_TOLERANCE_S` é só uma margem de
// segurança contra folga da própria API de gravação (ex.: um frame a mais ou
// a menos na hora de cortar), não uma janela pensada pra pessoa escolher.
export const RECORDING_DURATION_S = 8.5;
export const RECORDING_TOLERANCE_S = 0.3;

/** Duração válida para vídeo selecionado da galeria (intervalo livre, como sempre foi). */
export function isDurationValid(durationMs: number): boolean {
  const durationS = durationMs / 1000;
  return durationS >= MIN_DURATION_S && durationS <= MAX_DURATION_S;
}

/** Duração válida para vídeo gravado na hora (janela apertada em torno de `RECORDING_DURATION_S`). */
export function isRecordingDurationValid(durationMs: number): boolean {
  const durationS = durationMs / 1000;
  return Math.abs(durationS - RECORDING_DURATION_S) <= RECORDING_TOLERANCE_S;
}

export function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
