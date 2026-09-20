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
 * app, retorno ao primeiro plano, wifi conectar) — ver `App.tsx` — e também
 * logo após um cadastro/edição/exclusão, direto da tela (ver
 * `CochosScreen.salvarCocho`/`confirmarExclusao`).
 *
 * Usa `temConexaoConectada` (wifi OU dados móveis), não `temWifiConectado`:
 * o payload aqui é um JSON de poucas centenas de bytes, não um vídeo — não
 * há razão pra represar isso esperando wifi como o envio de vídeo espera. Já
 * fazia sentido esperar por wifi quando isso significava só "atualiza mais
 * tarde"; o problema é que o cadastro fica só neste aparelho enquanto isso
 * (`sincronizado: false`), e desinstalar o app (ou trocar de aparelho) antes
 * do wifi aparecer apaga esse cadastro pra sempre, sem nunca ter chegado ao
 * backend — foi exatamente isso que causou um cocho cadastrado "sumir" após
 * reinstalar (ver decisão registrada no projeto Claude, 2026-09-20).
 *
 * Cada item tenta `TENTATIVAS_IMEDIATAS` vezes, com uma espera curta entre
 * elas, antes de desistir e deixar pro próximo gatilho externo (abrir o
 * app, voltar ao primeiro plano, conectar numa rede) — sem isso, um soluço
 * passageiro do backend (acordando de hibernação no Render, ou no meio de
 * um redeploy disparado por outra escrita neste mesmo registro) só teria
 * uma chance de emplacar, e se a pessoa fechar/desinstalar o app antes do
 * próximo gatilho, o cadastro se perde — foi exatamente esse encadeamento
 * que fez um cocho nunca chegar a virar commit no GitHub (ver decisão
 * registrada no projeto Claude, 2026-09-20).
 */
import { excluirCochoNoBackend, registrarCochoNoBackend } from "@/api/client";
import { obterChaveAdmin } from "@/services/adminKey";
import {
  listarCochosNaoSincronizados,
  listarExclusoesPendentes,
  marcarCochoComoSincronizado,
  removerExclusaoPendente,
} from "@/services/cochoStorage";
import { temConexaoConectada } from "@/services/syncEngine";

let sincronizacaoEmAndamento = false;

const TENTATIVAS_IMEDIATAS = 2;
const ESPERA_ENTRE_TENTATIVAS_MS = 4000;

function aguardar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Roda `fazer()` até `TENTATIVAS_IMEDIATAS` vezes, com espera curta entre
 * tentativas, engolindo o erro no final (ver comentário no topo do arquivo
 * — próximo gatilho externo cuida do resto se mesmo assim não emplacar). */
async function comTentativasImediatas(fazer: () => Promise<void>): Promise<void> {
  for (let tentativa = 1; tentativa <= TENTATIVAS_IMEDIATAS; tentativa++) {
    try {
      await fazer();
      return;
    } catch {
      if (tentativa < TENTATIVAS_IMEDIATAS) {
        await aguardar(ESPERA_ENTRE_TENTATIVAS_MS);
      }
      // Na última tentativa, cai fora do loop e simplesmente não faz nada —
      // silencioso de propósito, tenta de novo no próximo gatilho.
    }
  }
}

export async function sincronizarCochos(): Promise<void> {
  if (sincronizacaoEmAndamento) return;
  sincronizacaoEmAndamento = true;
  try {
    if (!(await temConexaoConectada())) return;

    // Só quem tem a chave de administrador configurada neste aparelho (ver
    // `services/adminKey.ts`) consegue de fato escrever no backend — sem
    // ela o backend responde 401 e cada tentativa abaixo cai no catch
    // silencioso, sem diferença de comportamento visível.
    const chaveAdmin = await obterChaveAdmin();

    const pendentes = await listarCochosNaoSincronizados();
    for (const cocho of pendentes) {
      await comTentativasImediatas(async () => {
        await registrarCochoNoBackend(cocho, chaveAdmin);
        await marcarCochoComoSincronizado(cocho.id);
      });
    }

    // Cochos excluídos localmente que já tinham sincronizado antes — ver
    // `cochoStorage.excluirCocho`.
    const exclusoesPendentes = await listarExclusoesPendentes();
    for (const id of exclusoesPendentes) {
      await comTentativasImediatas(async () => {
        await excluirCochoNoBackend(id, chaveAdmin);
        await removerExclusaoPendente(id);
      });
    }
  } finally {
    sincronizacaoEmAndamento = false;
  }
}
