/**
 * Motor de sincronização: percorre a fila local (`offlineQueue`) e envia
 * cada captura pendente ao backend quando há wifi conectado.
 *
 * Não lança exceções para quem chama: falhas ficam registradas no próprio
 * item da fila (`status: "erro"`, `lastError`) para nova tentativa depois —
 * o vídeo nunca é descartado por causa de um envio malsucedido.
 *
 * O backend já é idempotente por `capture_id` (ver `total_..._reprocessado`
 * em `CaptureResponse`), então um possível envio duplicado — por exemplo, a
 * sincronização em segundo plano e um toque manual de "tentar novamente"
 * disparando quase ao mesmo tempo — não gera frames duplicados no dataset.
 * Ainda assim, `itemsEmEnvio` evita a maior parte dessas corridas no cliente.
 */
import NetInfo from "@react-native-community/netinfo";

import { ApiError, uploadCapture } from "@/api/client";
import type { CaptureResponse } from "@/types/capture";
import {
  getQueueItem,
  listQueue,
  removeFromQueue,
  updateQueueItem,
  type QueueItem,
} from "@/services/offlineQueue";
import { marcarComoCanceladoNoHistorico, marcarComoEnviadoNoHistorico } from "@/services/historicoEnvios";
import {
  LIMITE_TENTATIVAS_PARA_AVISAR,
  notificarEnvioConcluido,
  notificarFalhaPersistente,
} from "@/services/notifications";

const MAX_TENTATIVAS_EXIBIDAS = 20; // só limita o contador mostrado na UI, nunca para de tentar

type Ouvinte = () => void;
const ouvintes = new Set<Ouvinte>();

/** Avisa a UI sempre que a fila muda (item enviado, erro, nova tentativa...). */
export function subscribeQueueChanges(ouvinte: Ouvinte): () => void {
  ouvintes.add(ouvinte);
  return () => ouvintes.delete(ouvinte);
}

function notificarMudanca() {
  ouvintes.forEach((ouvinte) => ouvinte());
}

let sincronizacaoDaFilaEmAndamento = false;
const itemsEmEnvio = new Set<string>();

/** Wifi de verdade — dados móveis nunca contam, mesmo com boa conexão. */
export async function temWifiConectado(): Promise<boolean> {
  const estado = await NetInfo.fetch();
  return estado.type === "wifi" && estado.isConnected === true;
}

async function enviarItem(
  item: QueueItem,
  onProgress?: (fracao: number) => void
): Promise<CaptureResponse | null> {
  if (itemsEmEnvio.has(item.captureId)) return null;
  itemsEmEnvio.add(item.captureId);

  await updateQueueItem(item.captureId, { status: "enviando" });
  notificarMudanca();

  try {
    const resposta = await uploadCapture({
      captureId: item.captureId,
      video: {
        uri: item.videoUri,
        durationMs: item.durationMs,
        sizeBytes: item.sizeBytes,
        fileName: item.fileName,
        mimeType: item.mimeType,
      },
      form: item.form,
      onProgress,
    });
    await removeFromQueue(item.captureId);
    // Mesma lógica do histórico na Prévia: exibição não pode travar o envio.
    marcarComoEnviadoNoHistorico(item.captureId, {
      totalFrames: resposta.total_candidatos,
      framesAceitos: resposta.total_aprovados,
      split: resposta.split,
    }).catch(() => undefined);
    // Notificação é só um extra pra quem não está de olho no app — nunca
    // deve atrasar nem quebrar o fluxo de envio (a função já engole os
    // próprios erros).
    notificarEnvioConcluido({
      pesoKg: item.form.pesoKg,
      cochoId: item.form.cochoId,
      framesAceitos: resposta.total_aprovados,
      totalFrames: resposta.total_candidatos,
    });
    return resposta;
  } catch (error) {
    const mensagem = error instanceof ApiError ? error.message : "Falha inesperada ao enviar.";
    const tentativas = Math.min(item.attempts + 1, MAX_TENTATIVAS_EXIBIDAS);
    await updateQueueItem(item.captureId, {
      status: "erro",
      attempts: tentativas,
      lastError: mensagem,
      lastAttemptAt: Date.now(),
    });
    // Só avisa uma vez por captura, depois de algumas tentativas seguidas —
    // uma falha isolada (sem wifi, backend reiniciando) é normal e não deve
    // gerar notificação a cada retry automático.
    if (tentativas >= LIMITE_TENTATIVAS_PARA_AVISAR && !item.notificouFalha) {
      updateQueueItem(item.captureId, { notificouFalha: true }).catch(() => undefined);
      notificarFalhaPersistente({ pesoKg: item.form.pesoKg, cochoId: item.form.cochoId, tentativas });
    }
    return null;
  } finally {
    itemsEmEnvio.delete(item.captureId);
    notificarMudanca();
  }
}

/**
 * Percorre a fila e envia tudo que estiver pendente, um item por vez,
 * enquanto houver wifi. Usada pelos gatilhos automáticos (abrir o app,
 * wifi conectar, verificação periódica em segundo plano). Retorna quantas
 * capturas foram enviadas com sucesso nesta chamada.
 */
export async function sincronizarFila(): Promise<number> {
  if (sincronizacaoDaFilaEmAndamento) return 0;
  sincronizacaoDaFilaEmAndamento = true;
  let enviados = 0;
  try {
    if (!(await temWifiConectado())) return 0;

    const fila = await listQueue();
    for (const item of fila) {
      if (item.status === "enviando") continue;
      if (!(await temWifiConectado())) break; // perdeu wifi no meio do caminho

      const resposta = await enviarItem(item);
      if (resposta) enviados += 1;
    }
    return enviados;
  } finally {
    sincronizacaoDaFilaEmAndamento = false;
  }
}

/** Sincroniza uma captura específica com prioridade (tela de status). */
export async function sincronizarItem(
  captureId: string,
  onProgress?: (fracao: number) => void
): Promise<CaptureResponse | null> {
  const item = await getQueueItem(captureId);
  if (!item) return null;
  if (!(await temWifiConectado())) return null;
  return enviarItem(item, onProgress);
}

export type CancelamentoResultado = { ok: true } | { ok: false; motivo: string };

/**
 * Cancela o envio de uma captura pendente por escolha da própria pessoa
 * (ex.: vídeo corrompido) — apaga o vídeo do aparelho via
 * `removeFromQueue` e marca "cancelado" no histórico, pra nunca mais tentar
 * enviar de novo. Recusa cancelar um item que está sendo enviado neste
 * exato momento, pra evitar a corrida de marcar "cancelado" e o upload
 * terminar com sucesso logo em seguida.
 */
export async function cancelarCaptura(captureId: string): Promise<CancelamentoResultado> {
  const item = await getQueueItem(captureId);
  if (!item) {
    return { ok: false, motivo: "Essa captura não está mais aguardando envio." };
  }
  if (itemsEmEnvio.has(captureId)) {
    return { ok: false, motivo: "Esse vídeo está sendo enviado agora. Espere terminar e tente de novo." };
  }
  await removeFromQueue(captureId);
  await marcarComoCanceladoNoHistorico(captureId);
  notificarMudanca();
  return { ok: true };
}
