/**
 * Registro local de tipos de alimento — cadastrados uma vez no aparelho (ver
 * `TiposAlimentoScreen.tsx`) e reaproveitados em várias capturas.
 *
 * Mesma lógica de `cochoStorage.ts`: a pessoa é obrigada a selecionar um
 * tipo de alimento já cadastrado antes de gravar (Lobby -> Cochos -> Tipo de
 * alimento -> Nova captura), e os dados do tipo selecionado são embutidos
 * (snapshot) direto em cada captura no momento da gravação (ver
 * `CaptureFormScreen.tsx` e `types/capture.ts`) — não dependem deste
 * cadastro já ter sincronizado com o backend. Este arquivo é só a lista
 * local, sempre disponível mesmo offline; o envio ao backend (registro
 * auxiliar, para reaproveitar tipos de alimento entre aparelhos) é feito
 * por `tipoAlimentoSync.ts`, em segundo plano e sem nenhum status visível
 * na UI — ver comentário lá sobre por que isso é seguro.
 *
 * Guardado em `tipos-alimento.json` no armazenamento durável do app, com o
 * mesmo padrão de lock por fila de promises usado em `cochoStorage.ts`.
 */
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";

import type { TipoAlimentoPayload } from "@/api/client";
import type { TipoAlimento } from "@/types/capture";

export interface TipoAlimentoRegistrado extends TipoAlimento {
  createdAt: number;
  /** Sincronizado com sucesso no backend ao menos uma vez. Nunca exibido na
   * UI (a sincronização é velada, ver `tipoAlimentoSync.ts`) — usado só
   * internamente pra saber o que ainda falta enviar. */
  sincronizado: boolean;
}

const TIPOS_ALIMENTO_PATH = `${FileSystem.documentDirectory}tipos-alimento.json`;
// Ids de tipos de alimento excluídos localmente que já tinham sincronizado
// com o backend antes — precisam ser removidos de lá também, em segundo
// plano (ver `tipoAlimentoSync.ts`). Um tipo que nunca chegou a sincronizar
// não entra aqui: não existe nada pra remover do lado do backend.
const EXCLUSOES_PATH = `${FileSystem.documentDirectory}tipos-alimento-exclusoes-pendentes.json`;

let writeChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const resultado = writeChain.then(fn, fn);
  writeChain = resultado.catch(() => undefined);
  return resultado;
}

async function readRaw(): Promise<TipoAlimentoRegistrado[]> {
  const info = await FileSystem.getInfoAsync(TIPOS_ALIMENTO_PATH);
  if (!info.exists) return [];
  try {
    const raw = await FileSystem.readAsStringAsync(TIPOS_ALIMENTO_PATH);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRaw(items: TipoAlimentoRegistrado[]): Promise<void> {
  await FileSystem.writeAsStringAsync(TIPOS_ALIMENTO_PATH, JSON.stringify(items));
}

async function readExclusoesRaw(): Promise<string[]> {
  const info = await FileSystem.getInfoAsync(EXCLUSOES_PATH);
  if (!info.exists) return [];
  try {
    const raw = await FileSystem.readAsStringAsync(EXCLUSOES_PATH);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeExclusoesRaw(ids: string[]): Promise<void> {
  await FileSystem.writeAsStringAsync(EXCLUSOES_PATH, JSON.stringify(ids));
}

/** Lista os tipos de alimento cadastrados neste aparelho, mais recente primeiro. */
export async function listarTiposAlimento(): Promise<TipoAlimentoRegistrado[]> {
  const items = await readRaw();
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Cadastra um novo tipo de alimento. O `id` é gerado aqui — nunca digitado
 * pela pessoa, só o `nome` e a `densidadeAparenteKgL` são dela.
 */
export async function registrarTipoAlimento(dados: {
  nome: string;
  densidadeAparenteKgL: number;
}): Promise<TipoAlimentoRegistrado> {
  return withLock(async () => {
    const novo: TipoAlimentoRegistrado = {
      id: Crypto.randomUUID(),
      nome: dados.nome,
      densidadeAparenteKgL: dados.densidadeAparenteKgL,
      createdAt: Date.now(),
      sincronizado: false,
    };
    const items = await readRaw();
    items.push(novo);
    await writeRaw(items);
    return novo;
  });
}

/** Usado só por `tipoAlimentoSync.ts`, depois de confirmar o envio ao backend. */
export async function marcarTipoAlimentoComoSincronizado(id: string): Promise<void> {
  return withLock(async () => {
    const items = await readRaw();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return;
    items[index] = { ...items[index], sincronizado: true };
    await writeRaw(items);
  });
}

/** Usado só por `tipoAlimentoSync.ts`, pra saber o que ainda falta enviar. */
export async function listarTiposAlimentoNaoSincronizados(): Promise<TipoAlimentoRegistrado[]> {
  const items = await readRaw();
  return items.filter((item) => !item.sincronizado);
}

/**
 * Edita nome/densidade de um tipo de alimento já cadastrado (ver menu de
 * opções em `TiposAlimentoScreen.tsx`). Marca o tipo como não sincronizado
 * de novo, pra `tipoAlimentoSync.ts` reenviar a versão atualizada ao backend
 * — o cadastro lá é idempotente por id (ver `tipos_alimento.py`), então isso
 * só sobrescreve os dados antigos, nunca duplica. Devolve `undefined` se o
 * id não existir mais.
 */
export async function editarTipoAlimento(
  id: string,
  dados: { nome: string; densidadeAparenteKgL: number }
): Promise<TipoAlimentoRegistrado | undefined> {
  return withLock(async () => {
    const items = await readRaw();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    const atualizado: TipoAlimentoRegistrado = { ...items[index], ...dados, sincronizado: false };
    items[index] = atualizado;
    await writeRaw(items);
    return atualizado;
  });
}

/**
 * Remove um tipo de alimento da lista local. Não afeta nenhuma captura já
 * feita com esse tipo: o valor usado em cada captura é um retrato
 * (snapshot) já embutido nela no momento da gravação, nunca uma referência
 * a este cadastro (ver `CaptureFormData.tipoAlimento` em `types/capture.ts`).
 *
 * Se o tipo já tinha sincronizado com o backend, guarda o id na lista de
 * exclusões pendentes, pra `tipoAlimentoSync.ts` remover de lá também em
 * segundo plano — sem isso, o registro auxiliar do backend ficaria com um
 * tipo que a pessoa já removeu da própria lista.
 */
export async function excluirTipoAlimento(id: string): Promise<void> {
  return withLock(async () => {
    const items = await readRaw();
    const item = items.find((i) => i.id === id);
    const restantes = items.filter((i) => i.id !== id);
    await writeRaw(restantes);
    if (item?.sincronizado) {
      const exclusoes = await readExclusoesRaw();
      if (!exclusoes.includes(id)) {
        await writeExclusoesRaw([...exclusoes, id]);
      }
    }
  });
}

/** Usado só por `tipoAlimentoSync.ts`. */
export async function listarExclusoesPendentesTipoAlimento(): Promise<string[]> {
  return readExclusoesRaw();
}

/** Usado só por `tipoAlimentoSync.ts`, depois de confirmar a exclusão no backend. */
export async function removerExclusaoPendenteTipoAlimento(id: string): Promise<void> {
  return withLock(async () => {
    const exclusoes = await readExclusoesRaw();
    await writeExclusoesRaw(exclusoes.filter((existente) => existente !== id));
  });
}

/**
 * Combina a lista local com a lista trazida do backend
 * (`GET /api/tipos-alimento`, ver `api/client.listarTiposAlimentoNoBackend`)
 * — é assim que a lista fica compartilhada entre a equipe (ver
 * `TiposAlimentoScreen.carregarTiposAlimento`), com a cópia local servindo
 * de cache pra uso offline em campo.
 *
 * Regra idêntica a `cochoStorage.mesclarComServidor`: uma edição feita neste
 * aparelho e ainda não sincronizada (`sincronizado: false`) NUNCA é
 * sobrescrita pelo que vem do servidor — o próximo `sincronizarTiposAlimento()`
 * que resolve isso, no sentido aparelho -> backend. Um tipo já sincronizado
 * antes, por outro lado, é sempre atualizado com o que o servidor tem
 * (inclui edições feitas por outro aparelho) e é removido daqui se o
 * servidor não o conhece mais (excluído por outra pessoa da equipe) — a
 * menos que já esteja na lista de exclusões pendentes deste aparelho, caso
 * em que a remoção local já aconteceu e só falta a exclusão terminar de
 * sincronizar.
 */
export async function mesclarComServidor(
  tiposDoServidor: TipoAlimentoPayload[]
): Promise<TipoAlimentoRegistrado[]> {
  return withLock(async () => {
    const locais = await readRaw();
    const exclusoesPendentes = await readExclusoesRaw();
    const porId = new Map(locais.map((item) => [item.id, item]));

    for (const doServidor of tiposDoServidor) {
      if (exclusoesPendentes.includes(doServidor.id)) continue;
      const local = porId.get(doServidor.id);
      if (local && !local.sincronizado) continue; // edição local pendente vence, por ora
      porId.set(doServidor.id, {
        id: doServidor.id,
        nome: doServidor.nome,
        densidadeAparenteKgL: doServidor.densidadeAparenteKgL,
        createdAt: local?.createdAt ?? Date.now(),
        sincronizado: true,
      });
    }

    const idsDoServidor = new Set(tiposDoServidor.map((item) => item.id));
    for (const [id, item] of porId) {
      if (item.sincronizado && !idsDoServidor.has(id) && !exclusoesPendentes.includes(id)) {
        porId.delete(id);
      }
    }

    const mesclados = [...porId.values()];
    await writeRaw(mesclados);
    return [...mesclados].sort((a, b) => b.createdAt - a.createdAt);
  });
}
