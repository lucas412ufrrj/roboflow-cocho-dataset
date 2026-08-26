/**
 * Cliente de API do app móvel.
 *
 * IMPORTANTE: o app fala EXCLUSIVAMENTE com o nosso backend (autenticado via
 * `EXPO_PUBLIC_BACKEND_API_KEY`). A chave privada do Roboflow
 * (`ROBOFLOW_API_KEY`) nunca existe no bundle do app, em variáveis
 * `EXPO_PUBLIC_*` ou em qualquer resposta consumida aqui.
 */

import type { ApiErrorBody, CaptureFormData, CaptureResponse, SelectedVideo } from "@/types/capture";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "";
const BACKEND_API_KEY = process.env.EXPO_PUBLIC_BACKEND_API_KEY ?? "";

export class ApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface UploadCaptureParams {
  captureId: string;
  video: SelectedVideo;
  form: CaptureFormData;
  onProgress?: (fractionCompleted: number) => void;
}

function parsePesoKg(raw: string): number {
  const normalized = raw.trim().replace(",", ".");
  const value = Number(normalized);
  if (Number.isNaN(value)) {
    throw new Error("Peso inválido. Use um número, ex.: 12.5");
  }
  return value;
}

/**
 * Envia o vídeo e os metadados ao backend via multipart/form-data, com
 * acompanhamento de progresso de upload usando XMLHttpRequest (a API `fetch`
 * não expõe eventos de progresso de upload de forma confiável em RN/Expo).
 */
export function uploadCapture({
  captureId,
  video,
  form,
  onProgress,
}: UploadCaptureParams): Promise<CaptureResponse> {
  return new Promise((resolve, reject) => {
    if (!API_BASE_URL) {
      reject(new ApiError("EXPO_PUBLIC_API_BASE_URL não configurada."));
      return;
    }

    const pesoKg = parsePesoKg(form.pesoKg);

    const formData = new FormData();
    formData.append("video", {
      uri: video.uri,
      name: video.fileName || "video.mp4",
      type: video.mimeType || "video/mp4",
    } as unknown as Blob);
    formData.append("peso_kg", String(pesoKg));
    formData.append("capture_id", captureId);
    if (form.tipoAlimento) formData.append("tipo_alimento", form.tipoAlimento);
    if (form.cochoId) formData.append("cocho_id", form.cochoId);
    if (form.observacoes) formData.append("observacoes", form.observacoes);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}/api/captures`);
    xhr.setRequestHeader("X-Backend-Api-Key", BACKEND_API_KEY);
    xhr.setRequestHeader("Accept", "application/json");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };

    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body as CaptureResponse);
        } else {
          const errorBody = body as ApiErrorBody;
          reject(new ApiError(errorBody.detail ?? "Falha ao enviar captura.", xhr.status));
        }
      } catch {
        reject(new ApiError("Resposta inválida do servidor.", xhr.status));
      }
    };

    xhr.onerror = () => reject(new ApiError("Falha de rede ao enviar o vídeo."));
    xhr.ontimeout = () => reject(new ApiError("Tempo limite excedido ao enviar o vídeo."));
    xhr.timeout = 5 * 60 * 1000; // 5 minutos: vídeos + processamento podem demorar

    xhr.send(formData);
  });
}
