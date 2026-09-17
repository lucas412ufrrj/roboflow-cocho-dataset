/**
 * Permite abrir a tela de novidades ("O que há de novo?") a partir de
 * qualquer tela, sob demanda — não só quando o app detecta sozinho, na
 * abertura, que existe uma versão de changelog ainda não vista.
 *
 * O estado do modal mora em `App.tsx` (é lá que mora a lógica de "abrir
 * automaticamente se tiver algo novo", em `changelogVisto.ts`), então esse
 * módulo só guarda uma referência pra função que liga esse estado,
 * registrada por `App.tsx` assim que monta — o mesmo tipo de ponte usada em
 * `buildCheck.ts` para o aviso de build desatualizada.
 */
type Abridor = () => void;

let abridor: Abridor | null = null;

export function registrarAbridorDeChangelog(fn: Abridor): void {
  abridor = fn;
}

export function abrirChangelog(): void {
  abridor?.();
}
