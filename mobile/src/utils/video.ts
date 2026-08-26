export const MIN_DURATION_S = 7;
export const MAX_DURATION_S = 10;

export function isDurationValid(durationMs: number): boolean {
  const durationS = durationMs / 1000;
  return durationS >= MIN_DURATION_S && durationS <= MAX_DURATION_S;
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
