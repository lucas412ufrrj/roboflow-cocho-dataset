/**
 * Chave de administrador — guardada localmente só no(s) aparelho(s) de quem
 * administra a lista de cochos (hoje, só o Lucas). Configurada uma única vez
 * na tela Sobre (`SobreScreen.tsx`), não em toda ação.
 *
 * Enquanto essa chave não estiver configurada neste aparelho, `CochosScreen`
 * esconde "Registrar cocho" e o menu de editar/excluir — a pessoa só
 * enxerga e seleciona cochos já cadastrados. O backend também exige essa
 * mesma chave (`X-Admin-Api-Key`, ver `core/security.verify_admin_api_key`)
 * nos endpoints de escrita, então esconder o botão é conveniência de
 * interface, não a proteção em si.
 *
 * Isso é uma trava simples pra evitar edição acidental pela equipe em campo,
 * não proteção contra alguém decidido a extrair a chave do próprio app — uma
 * chave embutida num app Expo/RN pode ser encontrada por quem souber inspecionar
 * o pacote. Proteção de verdade exigiria login por pessoa validado no
 * servidor, planejado como evolução futura (ver comentário em
 * `config.ADMIN_API_KEY` no backend).
 *
 * Mesmo padrão de armazenamento local de `operador.ts`: um JSON no
 * armazenamento durável do app.
 */
import * as FileSystem from "expo-file-system/legacy";

const ADMIN_KEY_PATH = `${FileSystem.documentDirectory}admin-key.json`;

interface AdminKeyData {
  chave: string;
}

/** Lê a chave de administrador salva neste aparelho, se houver. `undefined`
 * quando nunca foi configurada. */
export async function obterChaveAdmin(): Promise<string | undefined> {
  try {
    const info = await FileSystem.getInfoAsync(ADMIN_KEY_PATH);
    if (!info.exists) return undefined;
    const raw = await FileSystem.readAsStringAsync(ADMIN_KEY_PATH);
    const parsed = JSON.parse(raw) as AdminKeyData;
    const chave = parsed?.chave?.trim();
    return chave || undefined;
  } catch {
    return undefined;
  }
}

/** Salva a chave de administrador neste aparelho. Uma string vazia limpa o
 * valor salvo (volta o aparelho ao modo "só leitura" da lista de cochos). */
export async function salvarChaveAdmin(chave: string): Promise<void> {
  const limpa = chave.trim();
  if (!limpa) {
    await FileSystem.deleteAsync(ADMIN_KEY_PATH, { idempotent: true }).catch(() => undefined);
    return;
  }
  const data: AdminKeyData = { chave: limpa };
  await FileSystem.writeAsStringAsync(ADMIN_KEY_PATH, JSON.stringify(data));
}
