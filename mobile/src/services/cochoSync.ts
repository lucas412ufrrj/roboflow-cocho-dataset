/**
 * Sincronização silenciosa do registro de cochos com o backend.
 *
 * Deliberadamente sem qualquer sinal na UI (nem contador, nem notificação,
 * nem tela de erro) — decisão explícita, não descuido. Isso é seguro porque
 * nenhuma captura depende deste envio ter dado certo: as medidas do cocho
 * selecionado vão embutidas (snapshot) direto em cada captura no momento da
 * gravação (ver `CaptureFormScreen.tsx` e `CaptureFormData.cocho` em
 * `types/capture.ts`), então mesmo que o registro de um cocho nunca chegue a
 * sincronizar, nenhuma imagem deixa de ter suas medidas associadas. Este
 * envio serve só para o backend acumular uma lista auxiliar de cochos
 * conhecidos, reaproveitável entre aparelhos.
 *
 * Roda pelos mesmos gatilhos de `syncEngine.sincronizarFila` (abertura do
 * app, retorno ao primeiro plano, wifi conectar) — ver `App.tsx`.
 */
import { excluirCochoNoBackend, registrarCochoNoBackend } from "@/api/client";
import { obterChaveAdmin } from "@/services/adminKey";
import {
  listarCochosNaoSincronizados,
  listarExclusoesPendentes,
  marcarCochoComoSincronizado,
  removerExclusaoPendente,
} from "@/services/cochoStorage";
import { temWifiConectado } from "@/services/syncEngine";

let sincronizacaoEmAndamento = false;

export async function sincronizarCochos(): Promise<void> {
  if (sincronizacaoEmAndamento) return;
  sincronizacaoEmAndamento = true;
  try {
    if (!(await temWifiConectado())) return;

    // Só quem tem a chave de administrador configurada neste aparelho (ver
    // `services/adminKey.ts`) consegue de fato escrever no backend — sem
    // ela o backend responde 401 e cada tentativa abaixo cai no catch
    // silencioso, sem diferença de comportamento visível.
    const chaveAdmin = await obterChaveAdmin();

    const pendentes = await listarCochosNaoSincronizados();
    for (const cocho of pendentes) {
      try {
        await registrarCochoNoBackend(cocho, chaveAdmin);
        await marcarCochoComoSincronizado(cocho.id);
      } catch {
        // Silencioso de propósito (ver comentário acima) — tenta de novo no
        // próximo gatilho, sem acumular erro nem avisar ninguém.
      }
    }

    // Cochos excluídos localmente que já tinham sincronizado antes — ver
    // `cochoStorage.excluirCocho`.
    const exclusoesPendentes = await listarExclusoesPendentes();
    for (const id of exclusoesPendentes) {
      try {
        await excluirCochoNoBackend(id, chaveAdmin);
        await removerExclusaoPendente(id);
      } catch {
        // Mesma lógica silenciosa acima.
      }
    }
  } finally {
    sincronizacaoEmAndamento = false;
  }
}
