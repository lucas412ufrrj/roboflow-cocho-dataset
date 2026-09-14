/**
 * Cliente de API do app móvel.
 *
 * IMPORTANTE: o app fala EXCLUSIVAMENTE com o nosso backend (autenticado via
 * `EXPO_PUBLIC_BACKEND_API_KEY`). A chave privada do Roboflow
 * (`ROBOFLOW_API_KEY`) nunca existe no bundle do app, em variáveis
 * `EXPO_PUBLIC_*` ou em qualquer resposta consumida aqui.
 */
import * as FileSystem from "expo-file-system/legacy";

import type { ApiErrorBody, CaptureFormData, CaptureResponse, SelectedVideo } from "@/types/capture";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "";
const BACKEND_API_KEY = process.env.EXPO_PUBLIC_BACKEND_API_KEY ?? "";

// Acima deste tamanho, o envio usa o caminho em blocos retomável (ver
// `uploadCaptureEmBlocos` mais abaixo) em vez do envio único de sempre —
// captura no campo costuma ter conexão de dados ruim/instável, e um vídeo
// grande que cai no meio do envio único tinha que recomeçar do zero.
// Vídeos pequenos continuam pelo caminho antigo, mais simples e com menos
// requisições.
const LIMIAR_ENVIO_EM_BLOCOS_BYTES = 8 * 1024 * 1024; // 8 MB
const TAMANHO_BLOCO_BYTES = 512 * 1024; // 512 KB por bloco

const TIMEOUT_INIT_MS = 30 * 1000;
const TIMEOUT_BLOCO_MS = 60 * 1000;
const TIMEOUT_CONCLUIR_MS = 5 * 60 * 1000; // mesmo processamento pesado do envio único

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
 * Envia o vídeo e os metadados ao backend.
 *
 * Decide entre os dois caminhos de envio pelo tamanho do arquivo — ver
 * `LIMIAR_ENVIO_EM_BLOCOS_BYTES` acima. A assinatura é a mesma nos dois
 * casos, então quem chama (`syncEngine.ts`) não precisa saber qual caminho
 * foi usado.
 */
export function uploadCapture(params: UploadCaptureParams): Promise<CaptureResponse> {
  if (params.video.sizeBytes >= LIMIAR_ENVIO_EM_BLOCOS_BYTES) {
    return uploadCaptureEmBlocos(params);
  }
  return uploadCaptureUnica(params);
}

/**
 * Envio único de sempre, via multipart/form-data, com acompanhamento de
 * progresso de upload usando XMLHttpRequest (a API `fetch` não expõe
 * eventos de progresso de upload de forma confiável em RN/Expo). Usado para
 * vídeos abaixo do limiar de envio em blocos.
 */
function uploadCaptureUnica({
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

    console.log(
      `[uploadCapture] iniciando envio único: captureId=${captureId} tamanho=${video.sizeBytes} bytes duracao=${video.durationMs}ms uri=${video.uri}`
    );

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
    // Quem gravou, configurado uma vez no Lobby — ver `services/operador.ts`.
    // Ausente quando nunca foi configurado no aparelho.
    if (form.operador) formData.append("operador", form.operador);
    // Horário real de gravação (epoch ms), quando o app conseguiu descobrir —
    // ver `RecordVideoScreen.obterHorarioReal`. Ausente em capturas feitas
    // antes desta versão ou quando nenhuma das duas fontes funcionou; o
    // backend cai de volta pro horário de recebimento do upload.
    if (video.recordedAt) formData.append("recorded_at", String(Math.round(video.recordedAt)));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}/api/captures`);
    xhr.setRequestHeader("X-Backend-Api-Key", BACKEND_API_KEY);
    xhr.setRequestHeader("Accept", "application/json");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        // No Android, o `event.total` reportado às vezes é um pouco menor que
        // os bytes de fato transmitidos (overhead do multipart entra depois
        // do cálculo inicial), então `loaded` pode passar de `total` perto do
        // fim. Sem o clamp, a barra de progresso passava de 100%.
        onProgress(Math.min(event.loaded / event.total, 1));
      }
    };

    xhr.onload = () => {
      console.log(
        `[uploadCapture] onload: status=${xhr.status} tamanhoResposta=${xhr.responseText?.length ?? 0} corpo="${(xhr.responseText ?? "").slice(0, 300)}"`
      );
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body as CaptureResponse);
        } else {
          const errorBody = body as ApiErrorBody;
          reject(new ApiError(errorBody.detail ?? "Falha ao enviar captura.", xhr.status));
        }
      } catch {
        const preview = (xhr.responseText ?? "").slice(0, 200) || "(corpo vazio)";
        reject(
          new ApiError(
            `Resposta inválida do servidor. status=${xhr.status} corpo="${preview}"`,
            xhr.status
          )
        );
      }
    };

    xhr.onerror = () => {
      console.log(`[uploadCapture] onerror: status=${xhr.status}`);
      reject(new ApiError(`Falha de rede ao enviar o vídeo. status=${xhr.status}`));
    };
    xhr.ontimeout = () => {
      console.log("[uploadCapture] ontimeout");
      reject(new ApiError("Tempo limite excedido ao enviar o vídeo."));
    };
    xhr.timeout = 5 * 60 * 1000; // 5 minutos: vídeos + processamento podem demorar

    xhr.send(formData);
  });
}

/** `fetch` com timeout manual (a API não tem timeout nativo) e erros de rede
 * traduzidos pra `ApiError` com mensagens no mesmo tom do envio único. */
async function fetchComTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  mensagemTimeout: string
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError(mensagemTimeout);
    }
    throw new ApiError("Falha de rede ao enviar o vídeo.");
  } finally {
    clearTimeout(timeoutId);
  }
}

async function lancarSeErro(response: Response, mensagemPadrao: string): Promise<void> {
  if (response.ok) return;
  let detail = mensagemPadrao;
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body?.detail) detail = body.detail;
  } catch {
    // corpo de erro não era JSON — mantém a mensagem padrão
  }
  throw new ApiError(detail, response.status);
}

interface InitBlocosResposta {
  status: "already_processed" | "in_progress";
  received_chunks: number[];
  result?: CaptureResponse;
}

/**
 * Abre (ou retoma) a sessão de envio em blocos no backend. Se o backend já
 * processou esse `capture_id` antes (reenvio depois de uma resposta perdida,
 * por exemplo), devolve o resultado direto, sem precisar reenviar nada. Caso
 * contrário, devolve quais blocos o backend já tem — pode ser uma lista
 * vazia (sessão nova) mesmo que o app já tenha enviado blocos antes, se o
 * processo do backend reiniciou nesse meio tempo; nesse caso o app
 * simplesmente reenvia tudo de novo, sem gerar dado incorreto.
 */
async function iniciarSessaoEmBlocos(params: {
  captureId: string;
  video: SelectedVideo;
  form: CaptureFormData;
  pesoKg: number;
  totalBlocos: number;
}): Promise<InitBlocosResposta> {
  const formData = new FormData();
  formData.append("capture_id", params.captureId);
  formData.append("total_size", String(params.video.sizeBytes));
  formData.append("chunk_size", String(TAMANHO_BLOCO_BYTES));
  formData.append("total_chunks", String(params.totalBlocos));
  formData.append("mime_type", params.video.mimeType || "video/mp4");
  formData.append("original_filename", params.video.fileName || "video.mp4");
  formData.append("peso_kg", String(params.pesoKg));
  if (params.form.tipoAlimento) formData.append("tipo_alimento", params.form.tipoAlimento);
  if (params.form.cochoId) formData.append("cocho_id", params.form.cochoId);
  if (params.form.observacoes) formData.append("observacoes", params.form.observacoes);
  if (params.form.operador) formData.append("operador", params.form.operador);
  if (params.video.recordedAt) {
    formData.append("recorded_at", String(Math.round(params.video.recordedAt)));
  }

  const response = await fetchComTimeout(
    `${API_BASE_URL}/api/captures/init`,
    {
      method: "POST",
      headers: { "X-Backend-Api-Key": BACKEND_API_KEY, Accept: "application/json" },
      body: formData,
    },
    TIMEOUT_INIT_MS,
    "Tempo limite excedido ao iniciar o envio."
  );
  await lancarSeErro(response, "Falha ao iniciar o envio em blocos.");
  return (await response.json()) as InitBlocosResposta;
}

/** Lê um trecho do vídeo direto do disco (sem carregar o arquivo inteiro na
 * memória) e envia como texto base64 — mais simples e confiável em RN/Expo
 * do que montar um corpo binário parcial, ao custo de ~33% a mais de bytes
 * na rede por bloco. Como o objetivo aqui é robustez em conexão ruim, não
 * velocidade bruta, essa troca vale a pena. */
async function enviarBloco(params: { captureId: string; index: number; base64: string }): Promise<void> {
  const response = await fetchComTimeout(
    `${API_BASE_URL}/api/captures/${params.captureId}/chunks/${params.index}`,
    {
      method: "POST",
      headers: {
        "X-Backend-Api-Key": BACKEND_API_KEY,
        Accept: "application/json",
        "Content-Type": "text/plain",
      },
      body: params.base64,
    },
    TIMEOUT_BLOCO_MS,
    `Tempo limite excedido ao enviar o bloco ${params.index + 1}.`
  );
  await lancarSeErro(response, `Falha ao enviar o bloco ${params.index + 1}.`);
}

/** Sinaliza que todos os blocos foram enviados — o backend junta tudo e
 * roda o mesmo pipeline (validação, normalização, extração de frames,
 * upload ao Roboflow) do envio único. Pode demorar o mesmo tanto que o
 * processamento do envio único de sempre. */
async function concluirSessaoEmBlocos(captureId: string): Promise<CaptureResponse> {
  const response = await fetchComTimeout(
    `${API_BASE_URL}/api/captures/${captureId}/complete`,
    {
      method: "POST",
      headers: { "X-Backend-Api-Key": BACKEND_API_KEY, Accept: "application/json" },
    },
    TIMEOUT_CONCLUIR_MS,
    "Tempo limite excedido ao concluir o envio."
  );
  await lancarSeErro(response, "Falha ao concluir o envio.");
  return (await response.json()) as CaptureResponse;
}

/**
 * Envio retomável em blocos, para vídeos grandes (ver
 * `LIMIAR_ENVIO_EM_BLOCOS_BYTES`). Em vez de mandar o vídeo inteiro numa só
 * requisição, divide em blocos de `TAMANHO_BLOCO_BYTES` e manda um de cada
 * vez — se a conexão cair no meio (comum em área rural/de campo), a
 * PRÓXIMA tentativa (disparada pelo `syncEngine` como qualquer erro normal
 * de envio) pergunta ao backend quais blocos já chegaram e só reenvia o
 * resto, em vez de recomeçar o vídeo inteiro do zero.
 */
async function uploadCaptureEmBlocos({
  captureId,
  video,
  form,
  onProgress,
}: UploadCaptureParams): Promise<CaptureResponse> {
  if (!API_BASE_URL) {
    throw new ApiError("EXPO_PUBLIC_API_BASE_URL não configurada.");
  }

  const pesoKg = parsePesoKg(form.pesoKg);
  const totalBlocos = Math.ceil(video.sizeBytes / TAMANHO_BLOCO_BYTES);

  console.log(
    `[uploadCaptureEmBlocos] iniciando envio em blocos: captureId=${captureId} tamanho=${video.sizeBytes} bytes totalBlocos=${totalBlocos}`
  );

  const init = await iniciarSessaoEmBlocos({ captureId, video, form, pesoKg, totalBlocos });
  if (init.status === "already_processed" && init.result) {
    console.log(`[uploadCaptureEmBlocos] captureId=${captureId} já processado antes, pulando envio.`);
    onProgress?.(1);
    return init.result;
  }

  const jaEnviados = new Set(init.received_chunks);
  console.log(
    `[uploadCaptureEmBlocos] captureId=${captureId}: ${jaEnviados.size}/${totalBlocos} blocos já recebidos, retomando do restante.`
  );

  for (let index = 0; index < totalBlocos; index++) {
    if (!jaEnviados.has(index)) {
      const position = index * TAMANHO_BLOCO_BYTES;
      const length = Math.min(TAMANHO_BLOCO_BYTES, video.sizeBytes - position);
      const base64 = await FileSystem.readAsStringAsync(video.uri, {
        encoding: FileSystem.EncodingType.Base64,
        position,
        length,
      });
      await enviarBloco({ captureId, index, base64 });
    }
    onProgress?.((index + 1) / totalBlocos);
  }

  return concluirSessaoEmBlocos(captureId);
}
