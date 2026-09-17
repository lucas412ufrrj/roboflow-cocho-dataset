/**
 * Fila local de capturas pendentes de envio.
 *
 * O vídeo é copiado para um diretório durável do próprio app
 * (`FileSystem.documentDirectory`) assim que a captura é confirmada na tela
 * de Prévia — antes disso o arquivo pode estar num cache temporário da
 * câmera/galeria que o sistema operacional é livre para apagar depois que a
 * tela de gravação é fechada.
 *
 * Um índice em JSON (`index.json`) guarda os metadados de cada item da fila.
 * Toda leitura/escrita do índice passa por `withLock` para serializar
 * chamadas concorrentes (ex.: o app tentando sincronizar no mesmo instante
 * em que o usuário confirma uma nova captura).
 */
import * as FileSystem from "expo-file-system/legacy";

import type { CaptureFormData, SelectedVideo } from "@/types/capture";

export type QueueItemStatus = "pendente" | "enviando" | "erro";

export interface QueueItem {
  captureId: string;
  videoUri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
  /**
   * Horário real de gravação (epoch ms) e origem do vídeo (câmera do app ou
   * galeria) — ver `SelectedVideo` em `types/capture.ts`. Ausentes em item
   * salvo por uma versão anterior do app, antes de estes campos existirem
   * aqui (eles eram perdidos entre a Prévia e o envio: `enqueueCapture`
   * nunca os persistia, então `recordedAt` nunca chegava no backend mesmo
   * quando descoberto com sucesso na gravação/seleção).
   */
  recordedAt?: number;
  origem?: "camera" | "galeria";
  form: CaptureFormData;
  createdAt: number;
  attempts: number;
  status: QueueItemStatus;
  lastError?: string;
  lastAttemptAt?: number;
  /** Já disparou a notificação de "falha persistente" pra esta captura —
   * evita avisar de novo a cada retry automático depois do primeiro aviso. */
  notificouFalha?: boolean;
}

const QUEUE_DIR = `${FileSystem.documentDirectory}capturas-pendentes/`;
const INDEX_PATH = `${QUEUE_DIR}index.json`;

let writeChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const resultado = writeChain.then(fn, fn);
  writeChain = resultado.catch(() => undefined);
  return resultado;
}

async function ensureQueueDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(QUEUE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(QUEUE_DIR, { intermediates: true });
  }
}

async function readIndexRaw(): Promise<QueueItem[]> {
  await ensureQueueDir();
  const info = await FileSystem.getInfoAsync(INDEX_PATH);
  if (!info.exists) return [];
  try {
    const raw = await FileSystem.readAsStringAsync(INDEX_PATH);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeIndexRaw(items: QueueItem[]): Promise<void> {
  await ensureQueueDir();
  await FileSystem.writeAsStringAsync(INDEX_PATH, JSON.stringify(items));
}

/** Lê a fila atual. Usado pela UI para exibir status; não precisa de lock. */
export async function listQueue(): Promise<QueueItem[]> {
  return readIndexRaw();
}

export async function getQueueItem(captureId: string): Promise<QueueItem | undefined> {
  const items = await readIndexRaw();
  return items.find((item) => item.captureId === captureId);
}

export async function countPending(): Promise<number> {
  const items = await readIndexRaw();
  return items.length;
}

/**
 * Copia o vídeo para armazenamento durável e registra a captura na fila.
 * Deve ser chamada no momento da confirmação, antes de qualquer tentativa de
 * upload — é o que garante que a captura sobrevive mesmo se o app for
 * fechado, o telefone reiniciar, ou o arquivo original do seletor sumir.
 */
export async function enqueueCapture(params: {
  captureId: string;
  video: SelectedVideo;
  form: CaptureFormData;
}): Promise<QueueItem> {
  return withLock(async () => {
    await ensureQueueDir();
    const extensao = params.video.fileName?.split(".").pop() || "mp4";
    const destino = `${QUEUE_DIR}${params.captureId}.${extensao}`;
    await FileSystem.copyAsync({ from: params.video.uri, to: destino });

    const item: QueueItem = {
      captureId: params.captureId,
      videoUri: destino,
      fileName: params.video.fileName || `${params.captureId}.${extensao}`,
      mimeType: params.video.mimeType || "video/mp4",
      sizeBytes: params.video.sizeBytes,
      durationMs: params.video.durationMs,
      recordedAt: params.video.recordedAt,
      origem: params.video.origem,
      form: params.form,
      createdAt: Date.now(),
      attempts: 0,
      status: "pendente",
    };

    const items = await readIndexRaw();
    items.push(item);
    await writeIndexRaw(items);
    return item;
  });
}

export async function updateQueueItem(
  captureId: string,
  patch: Partial<Pick<QueueItem, "status" | "attempts" | "lastError" | "lastAttemptAt" | "notificouFalha">>
): Promise<void> {
  return withLock(async () => {
    const items = await readIndexRaw();
    const index = items.findIndex((item) => item.captureId === captureId);
    if (index === -1) return;
    items[index] = { ...items[index], ...patch };
    await writeIndexRaw(items);
  });
}

export async function removeFromQueue(captureId: string): Promise<void> {
  return withLock(async () => {
    const items = await readIndexRaw();
    const item = items.find((i) => i.captureId === captureId);
    const restantes = items.filter((i) => i.captureId !== captureId);
    await writeIndexRaw(restantes);
    if (item) {
      const info = await FileSystem.getInfoAsync(item.videoUri);
      if (info.exists) {
        await FileSystem.deleteAsync(item.videoUri, { idempotent: true });
      }
    }
  });
}
