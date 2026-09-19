/**
 * Histórico de capturas: um registro permanente (diferente da fila de envio
 * em `offlineQueue.ts`, que é transiente e perde o item assim que ele é
 * enviado com sucesso). Serve só para a tela de Histórico mostrar o que já
 * foi feito, então nunca bloqueia nem afeta o envio de verdade — se alguma
 * escrita aqui falhar, a captura em si já está segura na fila.
 *
 * Guardado em `historico-envios.json` no armazenamento durável do app, com o
 * mesmo padrão de lock por fila de promises usado em `offlineQueue.ts`.
 */
import * as FileSystem from "expo-file-system/legacy";

import type { CaptureFormData, SplitType } from "@/types/capture";
import { removerMiniatura } from "@/services/thumbnails";

export type HistoricoStatus = "aguardando_sincronizacao" | "enviado" | "cancelado";

export interface HistoricoEntry {
  captureId: string;
  createdAt: number;
  pesoKg?: string;
  tipoAlimentoNome?: string;
  cochoNome?: string;
  status: HistoricoStatus;
  sentAt?: number;
  totalFrames?: number;
  framesAceitos?: number;
  split?: SplitType;
  /** Caminho local da miniatura do vídeo, gerada na hora da captura (ver
   * `PreviewScreen` + `services/thumbnails.ts`). Ausente em capturas de
   * versões antigas do app, ou quando a geração falhou. */
  thumbnailUri?: string;
}

/** Corta o array pro limite de entradas, removendo a miniatura de cada
 * entrada que sai — sem isso, o arquivo de imagem ficaria órfão pra sempre. */
function cortarEExpirarMiniaturas(items: HistoricoEntry[]): HistoricoEntry[] {
  if (items.length <= MAX_ENTRADAS) return items;
  const excedentes = items.slice(0, items.length - MAX_ENTRADAS);
  for (const item of excedentes) {
    removerMiniatura(item.captureId).catch(() => undefined);
  }
  return items.slice(items.length - MAX_ENTRADAS);
}

const HISTORICO_PATH = `${FileSystem.documentDirectory}historico-envios.json`;

// Limite pra não deixar o arquivo crescer pra sempre numa temporada de campo
// longa. Bem acima do que alguém rola manualmente, então na prática só corta
// histórico bem antigo.
const MAX_ENTRADAS = 500;

let writeChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const resultado = writeChain.then(fn, fn);
  writeChain = resultado.catch(() => undefined);
  return resultado;
}

async function readRaw(): Promise<HistoricoEntry[]> {
  const info = await FileSystem.getInfoAsync(HISTORICO_PATH);
  if (!info.exists) return [];
  try {
    const raw = await FileSystem.readAsStringAsync(HISTORICO_PATH);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRaw(items: HistoricoEntry[]): Promise<void> {
  await FileSystem.writeAsStringAsync(HISTORICO_PATH, JSON.stringify(items));
}

/** Lista o histórico, mais recente primeiro. */
export async function listarHistorico(): Promise<HistoricoEntry[]> {
  const items = await readRaw();
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Registra uma nova captura no histórico. Deve ser chamada logo depois de
 * `enqueueCapture` (na Prévia), com status inicial "aguardando_sincronizacao"
 * — o backend ainda não processou nada, então não há frames pra mostrar.
 */
export async function registrarNoHistorico(params: {
  captureId: string;
  form: CaptureFormData;
  thumbnailUri?: string;
}): Promise<void> {
  return withLock(async () => {
    const items = await readRaw();
    items.push({
      captureId: params.captureId,
      createdAt: Date.now(),
      pesoKg: params.form.pesoKg,
      tipoAlimentoNome: params.form.tipoAlimento.nome,
      cochoNome: params.form.cocho.nome,
      status: "aguardando_sincronizacao",
      thumbnailUri: params.thumbnailUri,
    });
    await writeRaw(cortarEExpirarMiniaturas(items));
  });
}

/**
 * Preenche retroativamente qualquer captura que esteja na fila local
 * (`offlineQueue`) mas não tenha registro aqui — órfã por causa de uma falha
 * silenciosa na hora de gravar (`registrarNoHistorico` não bloqueia o envio
 * de propósito) ou de uma captura feita antes da aba de Histórico existir.
 * Sem isso, a captura continua sendo enviada normalmente pelo `syncEngine`
 * (que lê só da fila, nunca do Histórico) mas some da visão da pessoa —
 * contando como "pendente" em qualquer contador que olhe a fila, sem
 * aparecer em lugar nenhum da tela de Histórico. Chamada sempre que a tela
 * de Histórico é aberta e na inicialização do app, pra nunca deixar acumular.
 */
export async function reconciliarComFila(
  itensDaFila: { captureId: string; form: CaptureFormData; createdAt: number }[]
): Promise<void> {
  if (itensDaFila.length === 0) return;
  return withLock(async () => {
    const items = await readRaw();
    const idsExistentes = new Set(items.map((item) => item.captureId));
    let mudou = false;
    for (const item of itensDaFila) {
      if (idsExistentes.has(item.captureId)) continue;
      items.push({
        captureId: item.captureId,
        createdAt: item.createdAt,
        pesoKg: item.form.pesoKg,
        tipoAlimentoNome: item.form.tipoAlimento.nome,
        cochoNome: item.form.cocho.nome,
        status: "aguardando_sincronizacao",
      });
      mudou = true;
    }
    if (!mudou) return;
    await writeRaw(cortarEExpirarMiniaturas(items));
  });
}

/** Marca uma captura como enviada, com os números que o backend devolveu. */
export async function marcarComoEnviadoNoHistorico(
  captureId: string,
  dados: { totalFrames: number; framesAceitos: number; split: SplitType }
): Promise<void> {
  return withLock(async () => {
    const items = await readRaw();
    const index = items.findIndex((item) => item.captureId === captureId);
    if (index === -1) return;
    items[index] = {
      ...items[index],
      status: "enviado",
      sentAt: Date.now(),
      totalFrames: dados.totalFrames,
      framesAceitos: dados.framesAceitos,
      split: dados.split,
    };
    await writeRaw(items);
  });
}

/**
 * Marca uma captura como cancelada pela própria pessoa (ex.: vídeo
 * corrompido) — usado junto com `removeFromQueue` em
 * `syncEngine.cancelarCaptura`, nunca sozinha.
 */
export async function marcarComoCanceladoNoHistorico(captureId: string): Promise<void> {
  return withLock(async () => {
    const items = await readRaw();
    const index = items.findIndex((item) => item.captureId === captureId);
    if (index === -1) return;
    items[index] = { ...items[index], status: "cancelado" };
    await writeRaw(items);
  });
}
