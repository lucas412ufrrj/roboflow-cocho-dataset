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

// Falhar uma ou duas vezes é normal (sem wifi, backend reiniciando etc.) — só
// avisa quando o número de tentativas malsucedidas passa desse limite, pra
// não notificar a cada retry automático em segundo plano.
export const LIMITE_TENTATIVAS_PARA_AVISAR = 5;

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

function detalheCaptura(params: { pesoKg?: string; cochoId?: string }): string {
  return [params.pesoKg ? `${params.pesoKg} kg` : null, params.cochoId ? `Cocho ${params.cochoId}` : null]
    .filter(Boolean)
    .join(" · ");
}

export function notificarEnvioConcluido(params: {
  pesoKg?: string;
  cochoId?: string;
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
  cochoId?: string;
  tentativas: number;
}): void {
  const detalhe = detalheCaptura(params);
  notificar(
    "Captura não está enviando",
    `${detalhe ? detalhe + " — " : ""}já tentou ${params.tentativas} vezes. Confira no Histórico.`
  );
}
