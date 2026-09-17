/**
 * Aviso de build nativa desatualizada.
 *
 * Diferente de atualização OTA (`expo-updates`, ver `UpdateBanner.tsx`), que
 * chega sozinha em qualquer build já instalada, uma mudança NATIVA (ícone,
 * permissão nova, módulo nativo novo) só chega instalando um APK novo — não
 * tem update que resolva. Esse módulo compara a versão nativa realmente
 * instalada no aparelho (`Constants.expoConfig?.version`, que reflete o
 * "version" do app.json embutido na build, imune a qualquer OTA — o mesmo
 * dado estático que `expo-updates` usa pra calcular o runtimeVersion) com a
 * mais recente que o backend conhece (`ULTIMA_VERSAO_NATIVA` em
 * `backend/app/config.py`, atualizada à mão pelo Lucas a cada `eas build`
 * que valha a pena avisar a equipe).
 *
 * Usa `expo-constants` em vez de `expo-application` de propósito: o módulo
 * nativo do `expo-constants` já vem linkado em qualquer build existente
 * (é dependência obrigatória do próprio pacote `expo` e também do
 * `expo-notifications`, já usado no app), então essa checagem funciona em
 * quem já tem o app instalado sem precisar de build nova. `expo-application`
 * exigiria linkar um módulo nativo novo, ou seja, uma build nova só pra essa
 * feature — o oposto do que ela deveria resolver.
 *
 * Puramente informativo: não bloqueia nada do app, só liga um aviso (ver
 * `components/OutdatedBuildBanner.tsx`) pra quem estiver numa build mais
 * antiga que a recomendada.
 */
import Constants from "expo-constants";

import { getAppInfo } from "@/api/client";

type Ouvinte = (desatualizada: boolean) => void;

let versaoDesatualizada = false;
const ouvintes = new Set<Ouvinte>();

function notificar(): void {
  ouvintes.forEach((ouvinte) => ouvinte(versaoDesatualizada));
}

export function subscribeBuildDesatualizada(ouvinte: Ouvinte): () => void {
  ouvintes.add(ouvinte);
  ouvinte(versaoDesatualizada);
  return () => {
    ouvintes.delete(ouvinte);
  };
}

/**
 * Compara duas versões no formato "X.Y.Z" (partes faltando contam como 0).
 * Devolve negativo se `a < b`, positivo se `a > b`, zero se iguais.
 * Comparação numérica por partes, não por string — "1.9.0" precisa ser
 * menor que "1.10.0", e como string isso daria o resultado errado.
 */
export function compararVersoes(a: string, b: string): number {
  const partesA = a.split(".").map((parte) => Number.parseInt(parte, 10) || 0);
  const partesB = b.split(".").map((parte) => Number.parseInt(parte, 10) || 0);
  const tamanho = Math.max(partesA.length, partesB.length);
  for (let i = 0; i < tamanho; i += 1) {
    const diferenca = (partesA[i] ?? 0) - (partesB[i] ?? 0);
    if (diferenca !== 0) return diferenca;
  }
  return 0;
}

/**
 * Consulta o backend e atualiza o estado de "build desatualizada". Chamado
 * na abertura do app e sempre que ele volta pro primeiro plano (mesmos
 * gatilhos de `sincronizarFila`, em `App.tsx`) — sem rede ou com o backend
 * fora do ar, simplesmente mantém o último estado conhecido e tenta de novo
 * na próxima chance, sem gerar erro nenhum pra quem está usando o app.
 */
export async function verificarBuildDesatualizada(): Promise<void> {
  try {
    const info = await getAppInfo();
    const instalada = Constants.expoConfig?.version ?? "0.0.0";
    const desatualizada = compararVersoes(instalada, info.ultima_versao_nativa) < 0;
    if (desatualizada !== versaoDesatualizada) {
      versaoDesatualizada = desatualizada;
      notificar();
    }
  } catch {
    // Sem internet, backend fora do ar ou resposta inesperada — não é um
    // problema que valha incomodar quem está usando o app; só não atualiza
    // o aviso agora, tenta de novo na próxima abertura/foreground.
  }
}
