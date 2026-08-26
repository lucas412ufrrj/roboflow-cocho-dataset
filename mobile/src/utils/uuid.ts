import * as Crypto from "expo-crypto";

/** Gera um UUID v4 para identificar cada vídeo capturado (capture_id). */
export function generateCaptureId(): string {
  return Crypto.randomUUID();
}
