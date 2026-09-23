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

// Quantas vezes tentar de novo, na hora, uma etapa do envio em blocos
// (init/bloco/complete) antes de desistir e deixar pro próximo gatilho
// externo (abrir o app, voltar ao primeiro plano, wifi conectar) — ver
// `comRetryDeRede` mais abaixo.
const TENTATIVAS_REDE_POR_ETAPA = 3;
const ESPERA_ENTRE_TENTATIVAS_REDE_MS = 3000;

export class ApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface AppInfo {
  app: string;
  roboflow_workspace: string;
  roboflow_project: string;
  ultima_versao_nativa: string;
}

const TIMEOUT_APP_INFO_MS = 8 * 1000;

/**
 * Consulta a raiz do backend (`GET /`), que não exige autenticação — hoje
 * usado só pra saber qual é a última versão nativa recomendada (ver
 * `services/buildCheck.ts`). Lança `ApiError` em qualquer falha (rede,
 * timeout, resposta inesperada) — quem chama decide o que fazer (nesse caso,
 * simplesmente não atualizar o aviso e tentar de novo depois).
 */
export async function getAppInfo(): Promise<AppInfo> {
  const response = await fetchComTimeout(
    `${API_BASE_URL}/`,
    { method: "GET" },
    TIMEOUT_APP_INFO_MS,
    "Tempo esgotado ao consultar informações do backend."
  );
  await lancarSeErro(response, "Falha ao consultar informações do backend.");
  return (await response.json()) as AppInfo;
}

export interface CochoPayload {
  id: string;
  nome: string;
  comprimentoCm: number;
  larguraCm: number;
  alturaCm: number;
  experimento: string;
}

// 60s (não os 15s de antes): registro de cocho é uma chamada silenciosa em
// segundo plano, não bloqueia nenhuma tela — não custa nada esperar mais.
// Vale a pena porque o backend pode estar acordando de hibernação (Render
// plano free) ou no meio de um redeploy disparado por outra escrita no
// mesmo registro (ver decisão registrada no projeto Claude, 2026-09-20:
// cadastrar um cocho enquanto o backend estava fora do ar por causa da
// escrita do tipo de alimento é o que causou um cadastro nunca chegar a
// virar commit no GitHub). 15s não dava tempo de sobreviver a nenhum dos
// dois casos.
const TIMEOUT_COCHO_MS = 60 * 1000;

/**
 * Registra (ou reenvia, se já existir) um cocho no backend — ver
 * `services/cochoSync.ts`, que chama isto em segundo plano, sem nenhum
 * status visível na UI. Idempotente por `id` (gerado no aparelho): reenviar
 * o mesmo cocho só sobrescreve com os mesmos dados, nunca duplica.
 *
 * `chaveAdmin` é a chave configurada localmente em `SobreScreen.tsx` (ver
 * `services/adminKey.ts`) — o backend exige ela além de `BACKEND_API_KEY`
 * pra qualquer escrita no registro de cochos (`verify_admin_api_key`).
 * `undefined` quando o aparelho não é de administrador: a chamada segue
 * mesmo assim e o backend responde 401, tratado silenciosamente por quem
 * chama (ver `cochoSync.ts`).
 */
export async function registrarCochoNoBackend(cocho: CochoPayload, chaveAdmin?: string): Promise<void> {
  if (!API_BASE_URL) {
    throw new ApiError("EXPO_PUBLIC_API_BASE_URL não configurada.");
  }
  const headers: Record<string, string> = {
    "X-Backend-Api-Key": BACKEND_API_KEY,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (chaveAdmin) headers["X-Admin-Api-Key"] = chaveAdmin;
  const response = await fetchComTimeout(
    `${API_BASE_URL}/api/cochos`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        cocho_id: cocho.id,
        nome: cocho.nome,
        comprimento_cm: cocho.comprimentoCm,
        largura_cm: cocho.larguraCm,
        altura_cm: cocho.alturaCm,
        experimento: cocho.experimento,
      }),
    },
    TIMEOUT_COCHO_MS,
    "Tempo limite excedido ao registrar o cocho."
  );
  await lancarSeErro(response, "Falha ao registrar o cocho.");
}

/**
 * Remove um cocho do registro auxiliar do backend — ver
 * `services/cochoSync.ts`, chamado em segundo plano depois de uma exclusão
 * local, sem nenhum status visível na UI. Idempotente: excluir de novo um id
 * que já não existe lá não é erro. `chaveAdmin`: ver comentário em
 * `registrarCochoNoBackend` acima.
 */
export async function excluirCochoNoBackend(id: string, chaveAdmin?: string): Promise<void> {
  if (!API_BASE_URL) {
    throw new ApiError("EXPO_PUBLIC_API_BASE_URL não configurada.");
  }
  const headers: Record<string, string> = { "X-Backend-Api-Key": BACKEND_API_KEY, Accept: "application/json" };
  if (chaveAdmin) headers["X-Admin-Api-Key"] = chaveAdmin;
  const response = await fetchComTimeout(
    `${API_BASE_URL}/api/cochos/${id}`,
    { method: "DELETE", headers },
    TIMEOUT_COCHO_MS,
    "Tempo limite excedido ao excluir o cocho."
  );
  await lancarSeErro(response, "Falha ao excluir o cocho.");
}

interface CochoBackendResponse {
  cocho_id: string;
  nome: string;
  comprimento_cm: number;
  largura_cm: number;
  altura_cm: number;
  experimento: string;
  criado_em: number;
}

/**
 * Busca a lista de cochos conhecida pelo backend — a lista compartilhada
 * entre a equipe toda (ver `services/cochoStorage.mesclarComServidor`, que
 * combina isto com o cadastro/exclusão ainda pendentes de sincronizar neste
 * aparelho). Usa só `BACKEND_API_KEY`: ler a lista não exige a chave de
 * administrador, só escrever nela.
 */
export async function listarCochosNoBackend(): Promise<CochoPayload[]> {
  if (!API_BASE_URL) {
    throw new ApiError("EXPO_PUBLIC_API_BASE_URL não configurada.");
  }
  const response = await fetchComTimeout(
    `${API_BASE_URL}/api/cochos`,
    { method: "GET", headers: { "X-Backend-Api-Key": BACKEND_API_KEY, Accept: "application/json" } },
    TIMEOUT_COCHO_MS,
    "Tempo limite excedido ao buscar a lista de cochos."
  );
  await lancarSeErro(response, "Falha ao buscar a lista de cochos.");
  const body = (await response.json()) as CochoBackendResponse[];
  return body.map((item) => ({
    id: item.cocho_id,
    nome: item.nome,
    comprimentoCm: item.comprimento_cm,
    larguraCm: item.largura_cm,
    alturaCm: item.altura_cm,
    experimento: item.experimento,
  }));
}

export interface TipoAlimentoPayload {
  id: string;
  nome: string;
  densidadeAparenteKgL: number;
}

// Mesmo raciocínio de TIMEOUT_COCHO_MS acima — ver comentário lá.
const TIMEOUT_TIPO_ALIMENTO_MS = 60 * 1000;

/**
 * Registra (ou reenvia, se já existir) um tipo de alimento no backend — ver
 * `services/tipoAlimentoSync.ts`, que chama isto em segundo plano, sem
 * nenhum status visível na UI. Idempotente por `id` (gerado no aparelho):
 * reenviar o mesmo tipo só sobrescreve com os mesmos dados, nunca duplica.
 *
 * `chaveAdmin`: ver comentário em `registrarCochoNoBackend` acima — mesma
 * lógica, exigida além de `BACKEND_API_KEY` pra qualquer escrita no
 * registro de tipos de alimento (`verify_admin_api_key`).
 */
export async function registrarTipoAlimentoNoBackend(
  tipoAlimento: TipoAlimentoPayload,
  chaveAdmin?: string
): Promise<void> {
  if (!API_BASE_URL) {
    throw new ApiError("EXPO_PUBLIC_API_BASE_URL não configurada.");
  }
  const headers: Record<string, string> = {
    "X-Backend-Api-Key": BACKEND_API_KEY,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (chaveAdmin) headers["X-Admin-Api-Key"] = chaveAdmin;
  const response = await fetchComTimeout(
    `${API_BASE_URL}/api/tipos-alimento`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        tipo_alimento_id: tipoAlimento.id,
        nome: tipoAlimento.nome,
        densidade_aparente_kg_l: tipoAlimento.densidadeAparenteKgL,
      }),
    },
    TIMEOUT_TIPO_ALIMENTO_MS,
    "Tempo limite excedido ao registrar o tipo de alimento."
  );
  await lancarSeErro(response, "Falha ao registrar o tipo de alimento.");
}

/**
 * Remove um tipo de alimento do registro auxiliar do backend — ver
 * `services/tipoAlimentoSync.ts`, chamado em segundo plano depois de uma
 * exclusão local, sem nenhum status visível na UI. Idempotente: excluir de
 * novo um id que já não existe lá não é erro. `chaveAdmin`: ver comentário
 * em `registrarCochoNoBackend` acima.
 */
export async function excluirTipoAlimentoNoBackend(id: string, chaveAdmin?: string): Promise<void> {
  if (!API_BASE_URL) {
    throw new ApiError("EXPO_PUBLIC_API_BASE_URL não configurada.");
  }
  const headers: Record<string, string> = { "X-Backend-Api-Key": BACKEND_API_KEY, Accept: "application/json" };
  if (chaveAdmin) headers["X-Admin-Api-Key"] = chaveAdmin;
  const response = await fetchComTimeout(
    `${API_BASE_URL}/api/tipos-alimento/${id}`,
    { method: "DELETE", headers },
    TIMEOUT_TIPO_ALIMENTO_MS,
    "Tempo limite excedido ao excluir o tipo de alimento."
  );
  await lancarSeErro(response, "Falha ao excluir o tipo de alimento.");
}

interface TipoAlimentoBackendResponse {
  tipo_alimento_id: string;
  nome: string;
  densidade_aparente_kg_l: number;
  criado_em: number;
}

/**
 * Busca a lista de tipos de alimento conhecida pelo backend — a lista
 * compartilhada entre a equipe toda (ver
 * `services/tipoAlimentoStorage.mesclarComServidor`, que combina isto com o
 * cadastro/exclusão ainda pendentes de sincronizar neste aparelho). Usa só
 * `BACKEND_API_KEY`: ler a lista não exige a chave de administrador, só
 * escrever nela.
 */
export async function listarTiposAlimentoNoBackend(): Promise<TipoAlimentoPayload[]> {
  if (!API_BASE_URL) {
    throw new ApiError("EXPO_PUBLIC_API_BASE_URL não configurada.");
  }
  const response = await fetchComTimeout(
    `${API_BASE_URL}/api/tipos-alimento`,
    { method: "GET", headers: { "X-Backend-Api-Key": BACKEND_API_KEY, Accept: "application/json" } },
    TIMEOUT_TIPO_ALIMENTO_MS,
    "Tempo limite excedido ao buscar a lista de tipos de alimento."
  );
  await lancarSeErro(response, "Falha ao buscar a lista de tipos de alimento.");
  const body = (await response.json()) as TipoAlimentoBackendResponse[];
  return body.map((item) => ({
    id: item.tipo_alimento_id,
    nome: item.nome,
    densidadeAparenteKgL: item.densidade_aparente_kg_l,
  }));
}

export interface UploadCaptureParams {
  captureId: string;
  video: SelectedVideo;
  form: CaptureFormData;
  onProgress?: (fractionCompleted: number) => void;
  /**
   * Chamado assim que os bytes do vídeo terminam de ser transmitidos e o app
   * passa a esperar o servidor terminar de processar (reassemblar os blocos
   * quando for o caso, extrair frames, validar o cocho, subir pro Roboflow).
   * Essa fase pode demorar bem mais que o envio em si — minutos, em vídeo
   * grande ou com o backend acordando de hibernação — sem nenhum progresso
   * adicional pra reportar nesse meio tempo. Sem esse aviso, quem está de
   * olho na barra de progresso vê ela parar em ~100% e parece travada.
   */
  onProcessingStart?: () => void;
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
  onProcessingStart,
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
    // Snapshot do tipo de alimento selecionado antes da gravação — sempre
    // presente (nunca omitido, ver `CaptureFormData.tipoAlimento` em
    // `types/capture.ts`), mesma lógica do snapshot de cocho logo abaixo.
    formData.append("tipo_alimento_id", form.tipoAlimento.id);
    formData.append("tipo_alimento_nome", form.tipoAlimento.nome);
    formData.append("tipo_alimento_densidade_aparente_kg_l", String(form.tipoAlimento.densidadeAparenteKgL));
    // Snapshot do cocho selecionado antes da gravação — sempre presente
    // (nunca omitido, ver `CaptureFormData.cocho` em `types/capture.ts`),
    // igual ao que já era feito com `origem` mais abaixo.
    formData.append("cocho_id", form.cocho.id);
    formData.append("cocho_nome", form.cocho.nome);
    formData.append("cocho_comprimento_cm", String(form.cocho.comprimentoCm));
    formData.append("cocho_largura_cm", String(form.cocho.larguraCm));
    formData.append("cocho_altura_cm", String(form.cocho.alturaCm));
    formData.append("cocho_experimento", form.cocho.experimento);
    if (form.observacoes) formData.append("observacoes", form.observacoes);
    // Quem gravou, configurado uma vez no Lobby — ver `services/operador.ts`.
    // Ausente quando nunca foi configurado no aparelho.
    if (form.operador) formData.append("operador", form.operador);
    // Horário real de gravação (epoch ms), quando o app conseguiu descobrir —
    // ver `RecordVideoScreen.obterHorarioReal`. Ausente em capturas feitas
    // antes desta versão ou quando nenhuma das duas fontes funcionou; o
    // backend cai de volta pro horário de recebimento do upload.
    if (video.recordedAt) formData.append("recorded_at", String(Math.round(video.recordedAt)));
    // Sempre explícito (nunca omitido): item de fila salvo por uma versão
    // anterior do app não tem esse campo, e "galeria" é o comportamento que
    // já existia antes dele — ver `SelectedVideo.origem` em `types/capture.ts`.
    formData.append("origem", video.origem ?? "galeria");

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
    // Dispara quando a transmissão do corpo termina, ANTES da resposta
    // chegar — a partir daqui o app só está esperando o servidor processar
    // o vídeo (pode levar bem mais tempo que o próprio envio, sem nenhum
    // progresso adicional). Sem esse aviso a barra fica parada em ~100% até
    // a resposta voltar e parece travada, mesmo com tudo correndo normal.
    xhr.upload.onloadend = () => {
      onProcessingStart?.();
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
  // Ver comentário equivalente em `uploadCaptureUnica` acima.
  formData.append("tipo_alimento_id", params.form.tipoAlimento.id);
  formData.append("tipo_alimento_nome", params.form.tipoAlimento.nome);
  formData.append(
    "tipo_alimento_densidade_aparente_kg_l",
    String(params.form.tipoAlimento.densidadeAparenteKgL)
  );
  // Ver comentário equivalente em `uploadCaptureUnica` acima.
  formData.append("cocho_id", params.form.cocho.id);
  formData.append("cocho_nome", params.form.cocho.nome);
  formData.append("cocho_comprimento_cm", String(params.form.cocho.comprimentoCm));
  formData.append("cocho_largura_cm", String(params.form.cocho.larguraCm));
  formData.append("cocho_altura_cm", String(params.form.cocho.alturaCm));
  formData.append("cocho_experimento", params.form.cocho.experimento);
  if (params.form.observacoes) formData.append("observacoes", params.form.observacoes);
  if (params.form.operador) formData.append("operador", params.form.operador);
  if (params.video.recordedAt) {
    formData.append("recorded_at", String(Math.round(params.video.recordedAt)));
  }
  formData.append("origem", params.video.origem ?? "galeria");

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
 * Reexecuta uma etapa do envio em blocos (init/bloco/complete) até
 * `TENTATIVAS_REDE_POR_ETAPA` vezes, com uma pausa curta entre elas, antes
 * de propagar o erro. Existe pra cobrir uma queda MOMENTÂNEA de sinal —
 * comum em campo — sem depender do próximo gatilho externo (abrir o app,
 * voltar ao primeiro plano, wifi conectar) pra retomar, que só aconteceria
 * minutos ou horas depois e faria a pessoa ver "Falha de rede" mesmo quando
 * a queda durou só alguns segundos.
 *
 * Repetir cada etapa aqui é seguro: `/init` e `/complete` são idempotentes
 * por `capture_id` no backend (reenviar não duplica nada), e reenviar um
 * bloco que na verdade já tinha chegado só grava o mesmo conteúdo de novo
 * por cima. Não distingue o tipo de erro de propósito — tanto uma queda de
 * rede quanto um 5xx passageiro do backend se beneficiam da mesma espera
 * curta antes de tentar de novo.
 */
async function comRetryDeRede<T>(tarefa: () => Promise<T>, descricao: string): Promise<T> {
  let ultimoErro: unknown;
  for (let tentativa = 1; tentativa <= TENTATIVAS_REDE_POR_ETAPA; tentativa++) {
    try {
      return await tarefa();
    } catch (erro) {
      ultimoErro = erro;
      console.log(
        `[uploadCaptureEmBlocos] ${descricao} falhou (tentativa ${tentativa}/${TENTATIVAS_REDE_POR_ETAPA}):`,
        erro
      );
      if (tentativa < TENTATIVAS_REDE_POR_ETAPA) {
        await new Promise((resolve) => setTimeout(resolve, ESPERA_ENTRE_TENTATIVAS_REDE_MS));
      }
    }
  }
  throw ultimoErro;
}

/**
 * Envio retomável em blocos, para vídeos grandes (ver
 * `LIMIAR_ENVIO_EM_BLOCOS_BYTES`). Em vez de mandar o vídeo inteiro numa só
 * requisição, divide em blocos de `TAMANHO_BLOCO_BYTES` e manda um de cada
 * vez — se a conexão cair no meio (comum em área rural/de campo), a
 * PRÓXIMA tentativa (disparada pelo `syncEngine` como qualquer erro normal
 * de envio) pergunta ao backend quais blocos já chegaram e só reenvia o
 * resto, em vez de recomeçar o vídeo inteiro do zero. Cada etapa individual
 * (init/bloco/complete) também tenta de novo sozinha algumas vezes antes
 * disso — ver `comRetryDeRede`.
 */
async function uploadCaptureEmBlocos({
  captureId,
  video,
  form,
  onProgress,
  onProcessingStart,
}: UploadCaptureParams): Promise<CaptureResponse> {
  if (!API_BASE_URL) {
    throw new ApiError("EXPO_PUBLIC_API_BASE_URL não configurada.");
  }

  const pesoKg = parsePesoKg(form.pesoKg);
  const totalBlocos = Math.ceil(video.sizeBytes / TAMANHO_BLOCO_BYTES);

  console.log(
    `[uploadCaptureEmBlocos] iniciando envio em blocos: captureId=${captureId} tamanho=${video.sizeBytes} bytes totalBlocos=${totalBlocos}`
  );

  const init = await comRetryDeRede(
    () => iniciarSessaoEmBlocos({ captureId, video, form, pesoKg, totalBlocos }),
    "iniciar sessão"
  );
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
      await comRetryDeRede(
        () => enviarBloco({ captureId, index, base64 }),
        `bloco ${index + 1}/${totalBlocos}`
      );
    }
    onProgress?.((index + 1) / totalBlocos);
  }

  // Todos os blocos chegaram — a partir daqui é o backend reassemblando e
  // rodando o processamento pesado (mesmo pipeline do envio único), sem mais
  // nada pra reportar como progresso até a resposta voltar.
  onProcessingStart?.();
  return comRetryDeRede(() => concluirSessaoEmBlocos(captureId), "concluir sessão");
}
