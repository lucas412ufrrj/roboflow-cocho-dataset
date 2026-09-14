/**
 * Rede de segurança para quando o app está totalmente fechado.
 *
 * Importante: isso NÃO é o mecanismo principal de sincronização — é um
 * complemento. O gatilho principal é o app abrir (ou voltar ao primeiro
 * plano, ou o wifi conectar com o app ainda vivo em memória), tratado em
 * `App.tsx` via `sincronizarFila()`. Esta tarefa cobre o caso em que a
 * equipe fecha o app na fazenda (sem sinal) e o celular só encontra wifi
 * horas depois, com o app já encerrado pelo sistema — sem isso, a
 * sincronização dependeria de alguém reabrir o app manualmente.
 *
 * `defineTask` precisa rodar sempre que o bundle JS é carregado, inclusive
 * quando o Android/iOS acorda o app apenas para executar a tarefa em
 * segundo plano (sem montar a árvore React) — por isso este módulo é
 * importado no topo do `App.tsx`, e não só dentro de um efeito.
 *
 * O intervalo (`minimumInterval`) é um mínimo, não uma garantia: o sistema
 * operacional decide quando realmente executar (na prática, algo entre
 * ~15 minutos e algumas horas no Android; de forma mais oportunista e menos
 * previsível no iOS).
 */
import * as BackgroundFetch from "expo-background-fetch";
import * as TaskManager from "expo-task-manager";

import { sincronizarFila } from "@/services/syncEngine";
import { configurarNotificacoes } from "@/services/notifications";

export const BACKGROUND_SYNC_TASK = "sincronizacao-fila-cocho";

TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    // Numa execução "headless" (app fechado, SO só acorda pra rodar esta
    // tarefa) o `App.tsx` nunca monta, então é aqui que o canal de
    // notificação do Android precisa existir antes de qualquer envio
    // terminar — `configurarNotificacoes` é idempotente, então repetir essa
    // chamada quando o app está aberto não tem custo.
    configurarNotificacoes();
    const enviados = await sincronizarFila();
    return enviados > 0
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch (error) {
    console.log("[backgroundSyncTask] erro:", error);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registrarSincronizacaoEmSegundoPlano(): Promise<void> {
  try {
    const jaRegistrada = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
    if (jaRegistrada) return;

    await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
      minimumInterval: 15 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch (error) {
    // Em alguns simuladores/emuladores o registro pode falhar; isso não deve
    // impedir o app de abrir nem quebrar a sincronização em primeiro plano.
    console.log("[backgroundSyncTask] não foi possível registrar:", error);
  }
}
