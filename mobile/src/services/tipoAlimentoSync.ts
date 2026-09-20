/**
 * Sincronização silenciosa do registro de tipos de alimento com o backend.
 *
 * Mesma lógica de `cochoSync.ts` — deliberadamente sem qualquer sinal na UI
 * (nem contador, nem notificação, nem tela de erro). Isso é seguro porque
 * nenhuma captura depende deste envio ter dado certo: o tipo de alimento
 * selecionado vai embutido (snapshot) direto em cada captura no momento da
 * gravação (ver `CaptureFormScreen.tsx` e `CaptureFormData.tipoAlimento` em
 * `types/capture.ts`), então mesmo que o registro de um tipo de alimento
 * nunca chegue a sincronizar, nenhuma imagem deixa de ter seu tipo
 * associado. Este envio serve só para o backend acumular uma lista auxiliar
 * de tipos de alimento conhecidos, reaproveitável entre aparelhos.
 *
 * Roda pelos mesmos gatilhos de `syncEngine.sincronizarFila` (abertura do
 * app, retorno ao primeiro plano, wifi conectar) — ver `App.tsx` — e também
 * logo após um cadastro/edição/exclusão, direto da tela (ver
 * `TiposAlimentoScreen.salvarTipo`/`confirmarExclusao`).
 *
 * Usa `temConexaoConectada` (wifi OU dados móveis), não `temWifiConectado` —
 * mesmo raciocínio de `cochoSync.ts` (ver comentário lá): o payload é um
 * JSON pequeno, e represar isso esperando wifi é o que já causou cadastro
 * perdido pra sempre ao desinstalar o app antes do wifi aparecer (ver
 * decisão registrada no projeto Claude, 2026-09-20).
 *
 * Cada item tenta `TENTATIVAS_IMEDIATAS` vezes antes de desistir e deixar
 * pro próximo gatilho externo — mesmo raciocínio de `cochoSync.ts` (ver
 * comentário lá): sobrevive a um soluço passageiro do backend sem depender
 * da pessoa reabrir o app a tempo.
 */
import { excluirTipoAlimentoNoBackend, registrarTipoAlimentoNoBackend } from "@/api/client";
import { obterChaveAdmin } from "@/services/adminKey";
import { temConexaoConectada } from "@/services/syncEngine";
import {
  listarExclusoesPendentesTipoAlimento,
  listarTiposAlimentoNaoSincronizados,
  marcarTipoAlimentoComoSincronizado,
  removerExclusaoPendenteTipoAlimento,
} from "@/services/tipoAlimentoStorage";

let sincronizacaoEmAndamento = false;

const TENTATIVAS_IMEDIATAS = 2;
const ESPERA_ENTRE_TENTATIVAS_MS = 4000;

function aguardar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mesma lógica de `cochoSync.comTentativasImediatas` — ver comentário lá. */
async function comTentativasImediatas(fazer: () => Promise<void>): Promise<void> {
  for (let tentativa = 1; tentativa <= TENTATIVAS_IMEDIATAS; tentativa++) {
    try {
      await fazer();
      return;
    } catch {
      if (tentativa < TENTATIVAS_IMEDIATAS) {
        await aguardar(ESPERA_ENTRE_TENTATIVAS_MS);
      }
    }
  }
}

export async function sincronizarTiposAlimento(): Promise<void> {
  if (sincronizacaoEmAndamento) return;
  sincronizacaoEmAndamento = true;
  try {
    if (!(await temConexaoConectada())) return;

    // Só quem tem a chave de administrador configurada neste aparelho (ver
    // `services/adminKey.ts`) consegue de fato escrever no backend — sem
    // ela o backend responde 401 e cada tentativa abaixo cai no catch
    // silencioso, sem diferença de comportamento visível.
    const chaveAdmin = await obterChaveAdmin();

    const pendentes = await listarTiposAlimentoNaoSincronizados();
    for (const tipo of pendentes) {
      await comTentativasImediatas(async () => {
        await registrarTipoAlimentoNoBackend(tipo, chaveAdmin);
        await marcarTipoAlimentoComoSincronizado(tipo.id);
      });
    }

    // Tipos de alimento excluídos localmente que já tinham sincronizado
    // antes — ver `tipoAlimentoStorage.excluirTipoAlimento`.
    const exclusoesPendentes = await listarExclusoesPendentesTipoAlimento();
    for (const id of exclusoesPendentes) {
      await comTentativasImediatas(async () => {
        await excluirTipoAlimentoNoBackend(id, chaveAdmin);
        await removerExclusaoPendenteTipoAlimento(id);
      });
    }
  } finally {
    sincronizacaoEmAndamento = false;
  }
}
