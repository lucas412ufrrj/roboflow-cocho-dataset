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
const progressoPorItem = new Map<string, number>();
// Captura cujos bytes já terminaram de subir mas cuja resposta ainda não
// voltou — o servidor está reassemblando (envio em blocos), extraindo
// frames, validando o cocho e subindo pro Roboflow. Isso pode levar bem mais
// tempo que o próprio envio (minutos, em vídeo grande ou backend acordando
// de hibernação), sem NENHUM progresso adicional pra reportar nesse meio
// tempo. Sem essa distinção, a barra fica parada em ~100% depois de
// terminar de enviar e parece travada, mesmo estando tudo normal.
const itemsProcessando = new Set<string>();

type OuvinteProgresso = (captureId: string, fracao: number) => void;
const ouvintesProgresso = new Set<OuvinteProgresso>();

type OuvinteProcessando = (captureId: string, processando: boolean) => void;
const ouvintesProcessando = new Set<OuvinteProcessando>();

/**
 * Avisa a UI a cada avanço do envio de uma captura específica (0 a 1). Fica
 * separado de `subscribeQueueChanges` de propósito: progresso dispara muitas
 * vezes por segundo durante um envio, enquanto mudanças de status (pendente
 * → enviando → enviado/erro) são raras — misturar os dois faria a tela de
 * Histórico recarregar a lista inteira do disco a cada pedacinho enviado.
 */
export function subscribeProgress(ouvinte: OuvinteProgresso): () => void {
  ouvintesProgresso.add(ouvinte);
  return () => ouvintesProgresso.delete(ouvinte);
}

function notificarProgresso(captureId: string, fracao: number) {
  ouvintesProgresso.forEach((ouvinte) => ouvinte(captureId, fracao));
}

/** Avisa a UI quando uma captura entra ou sai da fase "processando no
 * servidor" (bytes já enviados, aguardando o backend terminar). */
export function subscribeProcessando(ouvinte: OuvinteProcessando): () => void {
  ouvintesProcessando.add(ouvinte);
  return () => ouvintesProcessando.delete(ouvinte);
}

function notificarProcessando(captureId: string, processando: boolean) {
  ouvintesProcessando.forEach((ouvinte) => ouvinte(captureId, processando));
}

/**
 * true quando esta captura está sendo enviada NESTE exato instante — por
 * qualquer gatilho: automático ao conectar wifi, automático ao abrir o app,
 * verificação periódica em segundo plano, ou um toque manual em "Sincronizar
 * agora"/"Tentar novamente agora". É o que permite à tela de Histórico
 * explicar por que um toque em "Sincronizar agora" às vezes não envia nada
 * de novo: o vídeo já está a caminho por outro gatilho, não que nada esteja
 * acontecendo.
 */
export function estaEnviandoAgora(captureId: string): boolean {
  return itemsEmEnvio.has(captureId);
}

/** Wifi de verdade — dados móveis nunca contam, mesmo com boa conexão. */
export async function temWifiConectado(): Promise<boolean> {
  const estado = await NetInfo.fetch();
  return estado.type === "wifi" && estado.isConnected === true;
}

/**
 * Destrava itens "zumbis": capturas que ficaram gravadas com
 * `status: "enviando"` no índice local de uma execução anterior do app que
 * foi encerrada no meio do envio (fechada à força, apagada pelo sistema, ou
 * substituída por uma atualização OTA enquanto o upload rodava). `enviando`
 * SÓ é verdade de verdade enquanto o `captureId` também está em
 * `itemsEmEnvio` — que é só memória e começa vazia a cada abertura do app.
 * Sem essa limpeza, o item fica marcado "enviando" pra sempre: toda
 * sincronização futura (`sincronizarFila`) vê esse status e pula o item,
 * achando que já está em andamento em outro lugar, quando na verdade
 * ninguém está mais cuidando dele — um impasse permanente, não uma demora.
 *
 * Chamada sempre no início de `sincronizarFila`, antes de qualquer outra
 * checagem (não depende de wifi nem da trava de "já sincronizando" — é só
 * higiene do índice local em disco).
 */
async function limparEnviosZumbis(): Promise<void> {
  const fila = await listQueue();
  let houveMudanca = false;
  for (const item of fila) {
    if (item.status === "enviando" && !itemsEmEnvio.has(item.captureId)) {
      await updateQueueItem(item.captureId, {
        status: "erro",
        lastError: "Envio interrompido (o app foi fechado ou atualizado no meio do envio anterior). Tentando de novo.",
      });
      houveMudanca = true;
    }
  }
  // Avisa a UI já aqui, mesmo que o resto de `sincronizarFila` termine cedo
  // (ex.: sem wifi) — sem isso, um item destravado só apareceria atualizado
  // na tela na próxima mudança de foco, não imediatamente.
  if (houveMudanca) notificarMudanca();
}

async function enviarItem(
  item: QueueItem,
  onProgress?: (fracao: number) => void
): Promise<CaptureResponse | null> {
  if (itemsEmEnvio.has(item.captureId)) return null;
  itemsEmEnvio.add(item.captureId);
  progressoPorItem.set(item.captureId, 0);

  await updateQueueItem(item.captureId, { status: "enviando" });
  notificarMudanca();

  const reportarProgresso = (fracao: number) => {
    progressoPorItem.set(item.captureId, fracao);
    notificarProgresso(item.captureId, fracao);
    onProgress?.(fracao);
  };
  const reportarInicioProcessamento = () => {
    itemsProcessando.add(item.captureId);
    notificarProcessando(item.captureId, true);
  };

  try {
    const resposta = await uploadCapture({
      captureId: item.captureId,
      video: {
        uri: item.videoUri,
        durationMs: item.durationMs,
        sizeBytes: item.sizeBytes,
        fileName: item.fileName,
        mimeType: item.mimeType,
        recordedAt: item.recordedAt,
        origem: item.origem,
      },
      form: item.form,
      onProgress: reportarProgresso,
      onProcessingStart: reportarInicioProcessamento,
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
      cochoNome: item.form.cocho.nome,
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
      notificarFalhaPersistente({ pesoKg: item.form.pesoKg, cochoNome: item.form.cocho.nome, tentativas });
    }
    return null;
  } finally {
    itemsEmEnvio.delete(item.captureId);
    progressoPorItem.delete(item.captureId);
    if (itemsProcessando.delete(item.captureId)) {
      notificarProcessando(item.captureId, false);
    }
    notificarMudanca();
  }
}

/**
 * Resultado detalhado de uma passada de sincronização — pensado pra tela de
 * Histórico conseguir explicar de verdade por que "Sincronizar agora" às
 * vezes não envia nada, em vez de um "Nada enviado" genérico que cobre
 * situações bem diferentes entre si:
 *
 * - `jaEmAndamento`: já existe uma sincronização rodando (quase sempre um
 *   gatilho automático — abrir o app, ou o wifi acabou de conectar). Esse é
 *   o motivo mais comum na prática: a pessoa chega no wifi, abre o
 *   Histórico e já toca em "Sincronizar agora" antes do envio automático,
 *   que já começou sozinho, terminar.
 * - `semWifi`: não achou uma rede wifi conectada no momento da checagem.
 * - `falhas`: tentou enviar e falhou de verdade (erro do servidor, vídeo
 *   grande demais, conexão caiu no meio) — motivo real de cada uma vem do
 *   `lastError` que `enviarItem` grava no item da fila.
 * - `itensJaEmEnvio`: quantos itens pendentes foram pulados nesta passada
 *   porque já estavam sendo enviados por OUTRO gatilho específico daquele
 *   item (ex.: "Tentar novamente agora" da tela de Envio rodando ao mesmo
 *   tempo) — sem que a fila inteira estivesse travada (`jaEmAndamento`).
 */
export interface SincronizacaoResultado {
  enviados: number;
  totalPendentes: number;
  jaEmAndamento: boolean;
  semWifi: boolean;
  itensJaEmEnvio: number;
  falhas: Array<{ captureId: string; motivo: string }>;
}

/**
 * Percorre a fila e envia tudo que estiver pendente, um item por vez,
 * enquanto houver wifi. Usada pelos gatilhos automáticos (abrir o app,
 * wifi conectar, verificação periódica em segundo plano) e pelo botão
 * "Sincronizar agora" do Histórico.
 */
export async function sincronizarFila(): Promise<SincronizacaoResultado> {
  await limparEnviosZumbis();
  const totalPendentes = (await listQueue()).length;

  if (sincronizacaoDaFilaEmAndamento) {
    return { enviados: 0, totalPendentes, jaEmAndamento: true, semWifi: false, itensJaEmEnvio: 0, falhas: [] };
  }
  sincronizacaoDaFilaEmAndamento = true;
  let enviados = 0;
  let itensJaEmEnvio = 0;
  const falhas: Array<{ captureId: string; motivo: string }> = [];
  try {
    if (!(await temWifiConectado())) {
      return { enviados: 0, totalPendentes, jaEmAndamento: false, semWifi: true, itensJaEmEnvio: 0, falhas: [] };
    }

    const fila = await listQueue();
    for (const item of fila) {
      if (item.status === "enviando" || itemsEmEnvio.has(item.captureId)) {
        itensJaEmEnvio += 1;
        continue;
      }
      if (!(await temWifiConectado())) break; // perdeu wifi no meio do caminho

      const resposta = await enviarItem(item);
      if (resposta) {
        enviados += 1;
      } else {
        // enviarItem já engoliu o próprio erro e gravou `lastError` no item
        // da fila (a menos que outro gatilho tenha começado a enviar este
        // mesmo item entre o `listQueue()` acima e agora — nesse caso não há
        // nada de novo pra reportar aqui).
        const atual = await getQueueItem(item.captureId);
        if (atual?.lastError) {
          falhas.push({ captureId: item.captureId, motivo: atual.lastError });
        }
      }
    }
    return { enviados, totalPendentes, jaEmAndamento: false, semWifi: false, itensJaEmEnvio, falhas };
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
