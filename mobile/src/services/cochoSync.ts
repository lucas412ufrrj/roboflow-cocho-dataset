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
 *
 * `subscribeSincronizacaoCochos` avisa quem quiser (hoje só
 * `CochosScreen.tsx`, pro aviso de "N pendentes") toda vez que uma passada
 * de sincronização termina, não importa qual gatilho a disparou — sem isso,
 * uma sincronização disparada pelos gatilhos globais do `App.tsx` (abrir o
 * app, voltar ao primeiro plano, wifi conectar) enquanto a tela de Cochos já
 * estava aberta e em foco nunca atualizava o aviso, que ficava preso no
 * valor de quando a tela ganhou foco pela última vez — mesmo com o cadastro
 * já sincronizado de verdade (ver decisão registrada no projeto Claude,
 * 2026-09-20).
 *
 * Com aparelho conectado, o cadastro deve sair direto (sem esperar o
 * próximo gatilho externo) — a fila/retry acima é só a rede de segurança
 * pra quando o aparelho está sem sinal. Por isso, se `sincronizarCochos` é
 * chamado enquanto outra passada já está rodando (ex.: o gatilho global do
 * `App.tsx` ainda processando um item lento, bem quando `salvarCocho`
 * também chama esta função), a chamada nova não é só descartada: marca
 * `novaRodadaPendente` pra passada em andamento rodar de novo assim que
 * terminar, relendo `listarCochosNaoSincronizados()` do zero. Sem isso, o
 * cadastro que motivou essa segunda chamada só seria enviado no PRÓXIMO
 * gatilho externo, mesmo com internet o tempo todo — o oposto do que deve
 * acontecer quando o aparelho está conectado (ver decisão registrada no
 * projeto Claude, 2026-09-20).
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
let novaRodadaPendente = false;

const TENTATIVAS_IMEDIATAS = 2;
const ESPERA_ENTRE_TENTATIVAS_MS = 4000;

type Ouvinte = () => void;
const ouvintes = new Set<Ouvinte>();

/** Avisa toda vez que uma passada de `sincronizarCochos` termina, qualquer
 * que tenha sido o gatilho. Usado pra manter o aviso de pendência em
 * `CochosScreen.tsx` sempre atualizado, mesmo com a tela já aberta. */
export function subscribeSincronizacaoCochos(ouvinte: Ouvinte): () => void {
  ouvintes.add(ouvinte);
  return () => ouvintes.delete(ouvinte);
}

function notificarMudanca() {
  ouvintes.forEach((ouvinte) => ouvinte());
}

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
  if (sincronizacaoEmAndamento) {
    // Ver comentário no topo do arquivo — não descarta, pede uma rodada
    // extra assim que a atual terminar.
    novaRodadaPendente = true;
    return;
  }
  sincronizacaoEmAndamento = true;
  try {
    do {
      novaRodadaPendente = false;
      if (!(await temConexaoConectada())) return;

      // Só quem tem a chave de administrador configurada neste aparelho
      // (ver `services/adminKey.ts`) consegue de fato escrever no backend —
      // sem ela o backend responde 401 e cada tentativa abaixo cai no catch
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
    } while (novaRodadaPendente);
  } finally {
    sincronizacaoEmAndamento = false;
    notificarMudanca();
  }
}
