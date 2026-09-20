/**
 * Permite abrir a tela de novidades ("O que há de novo?") a partir de
 * qualquer tela, sob demanda — não só quando o app detecta sozinho, na
 * abertura, que existe uma versão de changelog ainda não vista.
 *
 * O estado do modal mora em `App.tsx`, então esse módulo só guarda uma
 * referência pra função que liga esse estado, registrada por `App.tsx`
 * assim que monta — o mesmo tipo de ponte usada em `buildCheck.ts` para o
 * aviso de build desatualizada.
 */
import { CHANGELOG } from "@/data/changelog";
import { obterUltimaVersaoVista } from "@/services/changelogVisto";

type Abridor = () => void;

let abridor: Abridor | null = null;

export function registrarAbridorDeChangelog(fn: Abridor): void {
  abridor = fn;
}

export function abrirChangelog(): void {
  abridor?.();
}

/**
 * Abre a tela de novidades automaticamente SE existir uma versão de
 * changelog mais nova do que a última que a pessoa já fechou.
 *
 * Usada em dois momentos: na abertura do app, só quando já existe um nome de
 * operador salvo (aparelho já configurado antes); e logo depois de salvar o
 * nome do operador pela primeira vez (`LobbyScreen.salvarOperador`). Os dois
 * gatilhos existem pra nunca competir com o modal obrigatório de nome do
 * operador numa instalação nova — antes desta função existir, os dois
 * modais podiam abrir juntos na primeira vez que o app rodava num aparelho
 * (ver decisão registrada em 2026-09-20).
 */
export async function verificarEAbrirChangelogSeNovo(): Promise<void> {
  const versaoMaisRecente = CHANGELOG[0]?.versao;
  if (!versaoMaisRecente) return;
  const versaoVista = await obterUltimaVersaoVista();
  if (versaoVista !== versaoMaisRecente) {
    abrirChangelog();
  }
}
