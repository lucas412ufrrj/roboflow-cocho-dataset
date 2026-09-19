/**
 * Guarda qual é a tela atual do app (nome da rota no `RootNavigator`), pra
 * outros módulos fora da árvore de navegação saberem se é um bom momento
 * pra fazer algo que interrompe a tela — hoje só usado por
 * `AutoUpdateApplier.tsx`, que só aplica uma atualização OTA sozinho
 * quando a pessoa está numa tela "parada" (ver lá).
 */
type Ouvinte = (rota: string | undefined) => void;

let rotaAtual: string | undefined;
const ouvintes = new Set<Ouvinte>();

/** Chamado pelo `RootNavigator` a cada troca de tela (e ao ficar pronto). */
export function registrarRotaAtual(nome: string | undefined): void {
  rotaAtual = nome;
  ouvintes.forEach((ouvinte) => ouvinte(rotaAtual));
}

export function obterRotaAtual(): string | undefined {
  return rotaAtual;
}

export function subscribeRotaAtual(ouvinte: Ouvinte): () => void {
  ouvintes.add(ouvinte);
  return () => {
    ouvintes.delete(ouvinte);
  };
}
