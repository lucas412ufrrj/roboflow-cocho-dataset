/**
 * Nome de quem está operando o app neste aparelho — configurado uma única vez
 * no Lobby (não por captura), pra não pedir de novo em toda gravação. Usado
 * só pra rastreabilidade nos metadados enviados ao Roboflow (`operador` em
 * `FrameMetadata`), ajudando a identificar se um problema de qualidade está
 * concentrado numa pessoa ou aparelho específico — não aparece na tela de
 * Histórico do app, que é escopo separado.
 *
 * Guardado em `operador.json` no armazenamento durável do app.
 */
import * as FileSystem from "expo-file-system/legacy";

const OPERADOR_PATH = `${FileSystem.documentDirectory}operador.json`;

interface OperadorData {
  nome: string;
}

/** Lê o nome salvo, se houver. `undefined` quando nunca foi configurado. */
export async function obterNomeOperador(): Promise<string | undefined> {
  try {
    const info = await FileSystem.getInfoAsync(OPERADOR_PATH);
    if (!info.exists) return undefined;
    const raw = await FileSystem.readAsStringAsync(OPERADOR_PATH);
    const parsed = JSON.parse(raw) as OperadorData;
    const nome = parsed?.nome?.trim();
    return nome || undefined;
  } catch {
    return undefined;
  }
}

/** Salva o nome de quem está operando. Uma string vazia limpa o valor salvo. */
export async function salvarNomeOperador(nome: string): Promise<void> {
  const limpo = nome.trim();
  if (!limpo) {
    await FileSystem.deleteAsync(OPERADOR_PATH, { idempotent: true }).catch(() => undefined);
    return;
  }
  const data: OperadorData = { nome: limpo };
  await FileSystem.writeAsStringAsync(OPERADOR_PATH, JSON.stringify(data));
}
