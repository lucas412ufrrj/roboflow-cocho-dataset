/**
 * Guarda qual foi a última versão do changelog que a pessoa já fechou, pra
 * tela de novidades não aparecer de novo toda vez que o app abre, só quando
 * tiver algo novo desde a última vez.
 */
import * as FileSystem from "expo-file-system/legacy";

const CAMINHO = `${FileSystem.documentDirectory}changelog-visto.json`;

export async function obterUltimaVersaoVista(): Promise<string | null> {
  try {
    const info = await FileSystem.getInfoAsync(CAMINHO);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(CAMINHO);
    const dados = JSON.parse(raw);
    return typeof dados?.ultimaVersaoVista === "string" ? dados.ultimaVersaoVista : null;
  } catch {
    return null;
  }
}

export async function marcarVersaoComoVista(versao: string): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(CAMINHO, JSON.stringify({ ultimaVersaoVista: versao }));
  } catch {
    // Não crítico: na pior das hipóteses o changelog aparece de novo.
  }
}
