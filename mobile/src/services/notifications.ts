/**
 * Notificações locais de sincronização — avisa quando uma captura pendente
 * termina de enviar (sucesso) ou fica emperrada tentando repetidamente
 * (falha persistente), mesmo com o app em segundo plano. São só
 * notificações locais, geradas no próprio aparelho: não depende de nenhum
 * servidor push nem de configuração adicional no backend.
 *
 * Nunca deve derrubar o fluxo de sincronização de verdade — qualquer falha
 * aqui (permissão negada, API indisponível) é ignorada silenciosamente.
 */
import * as Notifications from "expo-notifications";
import { AppState } from "react-native";

const CANAL_SINCRONIZACAO = "sincronizacao";

// Falhar uma ou duas vezes é normal (sem wifi, backend reiniciando etc.). A
// partir desse número de tentativas AUTOMÁTICAS malsucedidas seguidas, duas
// coisas acontecem (ver `syncEngine.ts`): (1) avisa a pessoa por notificação,
// uma única vez, em vez de notificar a cada retry; e (2) o vídeo para de ser
// tentado sozinho — fica parado em "erro" até um toque manual ("Sincronizar
// agora" no Histórico) ou até a captura ser editada (o que já reseta a
// contagem, ver `EditCaptureScreen.tsx`). Sem esse segundo limite, um vídeo
// com um problema permanente (ex.: peso inválido rejeitado pelo backend)
// ficava sendo retentado pra sempre a cada abertura do app/reconexão de
// wifi/verificação periódica, sem nunca desistir — ver decisão registrada no
// projeto Claude em 2026-09-27.
export const LIMITE_TENTATIVAS_AUTOMATICAS = 5;

let handlerConfigurado = false;

/** Chamar uma vez, na abertura do app (ver `App.tsx`). */
export function configurarNotificacoes(): void {
  if (handlerConfigurado) return;
  handlerConfigurado = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      // Com o app aberto a pessoa já vê o resultado na própria tela
      // (Histórico, banner de progresso) — a notificação nesse caso só
      // repetiria a mesma informação, então só aparece com o app em
      // segundo plano ou fechado.
      shouldShowBanner: AppState.currentState !== "active",
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  Notifications.setNotificationChannelAsync(CANAL_SINCRONIZACAO, {
    name: "Sincronização de capturas",
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch(() => undefined);
}

async function temPermissao(): Promise<boolean> {
  try {
    const atual = await Notifications.getPermissionsAsync();
    if (atual.granted) return true;
    const pedido = await Notifications.requestPermissionsAsync();
    return pedido.granted;
  } catch {
    return false;
  }
}

async function notificar(titulo: string, corpo: string): Promise<void> {
  if (!(await temPermissao())) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title: titulo, body: corpo },
      trigger: null,
    });
  } catch {
    // notificação é só um extra — nunca deve quebrar o envio de verdade
  }
}

function detalheCaptura(params: { pesoKg?: string; cochoNome?: string }): string {
  return [params.pesoKg ? `${params.pesoKg} kg` : null, params.cochoNome || null].filter(Boolean).join(" · ");
}

export function notificarEnvioConcluido(params: {
  pesoKg?: string;
  cochoNome?: string;
  framesAceitos: number;
  totalFrames: number;
}): void {
  const detalhe = detalheCaptura(params);
  notificar(
    "Captura enviada",
    `${detalhe ? detalhe + " — " : ""}${params.framesAceitos}/${params.totalFrames} frames aprovados.`
  );
}

export function notificarFalhaPersistente(params: {
  pesoKg?: string;
  cochoNome?: string;
  tentativas: number;
}): void {
  const detalhe = detalheCaptura(params);
  notificar(
    "Captura não está enviando",
    `${detalhe ? detalhe + " — " : ""}já tentou ${params.tentativas} vezes. Confira no Histórico.`
  );
}
