/**
 * Registro local de cochos — cadastrados uma vez no aparelho (ver
 * `CochosScreen.tsx`) e reaproveitados em várias capturas.
 *
 * A pessoa é obrigada a selecionar um cocho já cadastrado antes de gravar
 * (Lobby -> Cochos -> Nova captura), e as medidas do cocho selecionado são
 * embutidas (snapshot) direto em cada captura no momento da gravação (ver
 * `CaptureFormScreen.tsx` e `types/capture.ts`) — não dependem deste
 * cadastro já ter sincronizado com o backend. Este arquivo é só a lista
 * local, sempre disponível mesmo offline; o envio ao backend (registro
 * auxiliar, para reaproveitar cochos entre aparelhos) é feito por
 * `cochoSync.ts`, em segundo plano e sem nenhum status visível na UI — ver
 * comentário lá sobre por que isso é seguro.
 *
 * Guardado em `cochos.json` no armazenamento durável do app, com o mesmo
 * padrão de lock por fila de promises usado em `offlineQueue.ts`.
 */
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";

import type { CochoPayload } from "@/api/client";
import type { Cocho } from "@/types/capture";

export interface CochoRegistrado extends Cocho {
  createdAt: number;
  /** Sincronizado com sucesso no backend ao menos uma vez. Nunca exibido na
   * UI (a sincronização é velada, ver `cochoSync.ts`) — usado só internamente
   * pra saber o que ainda falta enviar. */
  sincronizado: boolean;
}

const COCHOS_PATH = `${FileSystem.documentDirectory}cochos.json`;
// Ids de cochos excluídos localmente que já tinham sincronizado com o
// backend antes — precisam ser removidos de lá também, em segundo plano
// (ver `cochoSync.ts`). Um cocho que nunca chegou a sincronizar não entra
// aqui: não existe nada pra remover do lado do backend.
const EXCLUSOES_PATH = `${FileSystem.documentDirectory}cochos-exclusoes-pendentes.json`;

let writeChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const resultado = writeChain.then(fn, fn);
  writeChain = resultado.catch(() => undefined);
  return resultado;
}

async function readRaw(): Promise<CochoRegistrado[]> {
  const info = await FileSystem.getInfoAsync(COCHOS_PATH);
  if (!info.exists) return [];
  try {
    const raw = await FileSystem.readAsStringAsync(COCHOS_PATH);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRaw(items: CochoRegistrado[]): Promise<void> {
  await FileSystem.writeAsStringAsync(COCHOS_PATH, JSON.stringify(items));
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

/** Lista os cochos cadastrados neste aparelho, mais recente primeiro. */
export async function listarCochos(): Promise<CochoRegistrado[]> {
  const items = await readRaw();
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Cadastra um novo cocho. O `id` é gerado aqui (mesmo padrão de
 * `generateCaptureId` em `utils/uuid.ts`) — nunca digitado pela pessoa, só o
 * `nome` é dela.
 */
export async function registrarCocho(dados: {
  nome: string;
  comprimentoCm: number;
  larguraCm: number;
  alturaCm: number;
  experimento: string;
}): Promise<CochoRegistrado> {
  return withLock(async () => {
    const novo: CochoRegistrado = {
      id: Crypto.randomUUID(),
      nome: dados.nome,
      comprimentoCm: dados.comprimentoCm,
      larguraCm: dados.larguraCm,
      alturaCm: dados.alturaCm,
      experimento: dados.experimento,
      createdAt: Date.now(),
      sincronizado: false,
    };
    const items = await readRaw();
    items.push(novo);
    await writeRaw(items);
    return novo;
  });
}

/** Usado só por `cochoSync.ts`, depois de confirmar o envio ao backend. */
export async function marcarCochoComoSincronizado(id: string): Promise<void> {
  return withLock(async () => {
    const items = await readRaw();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return;
    items[index] = { ...items[index], sincronizado: true };
    await writeRaw(items);
  });
}

/** Usado só por `cochoSync.ts`, pra saber o que ainda falta enviar. */
export async function listarCochosNaoSincronizados(): Promise<CochoRegistrado[]> {
  const items = await readRaw();
  return items.filter((item) => !item.sincronizado);
}

/**
 * Edita nome/medidas de um cocho já cadastrado (ver menu de opções em
 * `CochosScreen.tsx`). Marca o cocho como não sincronizado de novo, pra
 * `cochoSync.ts` reenviar a versão atualizada ao backend — o cadastro lá é
 * idempotente por id (ver `cochos.py`), então isso só sobrescreve os dados
 * antigos, nunca duplica. Devolve `undefined` se o id não existir mais.
 */
export async function editarCocho(
  id: string,
  dados: { nome: string; comprimentoCm: number; larguraCm: number; alturaCm: number; experimento: string }
): Promise<CochoRegistrado | undefined> {
  return withLock(async () => {
    const items = await readRaw();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    const atualizado: CochoRegistrado = { ...items[index], ...dados, sincronizado: false };
    items[index] = atualizado;
    await writeRaw(items);
    return atualizado;
  });
}

/**
 * Remove um cocho da lista local. Não afeta nenhuma captura já feita com
 * esse cocho: a medida usada em cada captura é um retrato (snapshot) já
 * embutido nela no momento da gravação, nunca uma referência a este
 * cadastro (ver `CaptureFormData.cocho` em `types/capture.ts`).
 *
 * Se o cocho já tinha sincronizado com o backend, guarda o id na lista de
 * exclusões pendentes, pra `cochoSync.ts` remover de lá também em segundo
 * plano — sem isso, o registro auxiliar do backend ficaria com um cocho que
 * a pessoa já removeu da própria lista.
 */
export async function excluirCocho(id: string): Promise<void> {
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

/** Usado só por `cochoSync.ts`. */
export async function listarExclusoesPendentes(): Promise<string[]> {
  return readExclusoesRaw();
}

/** Usado só por `cochoSync.ts`, depois de confirmar a exclusão no backend. */
export async function removerExclusaoPendente(id: string): Promise<void> {
  return withLock(async () => {
    const exclusoes = await readExclusoesRaw();
    await writeExclusoesRaw(exclusoes.filter((existente) => existente !== id));
  });
}

/**
 * Combina a lista local com a lista trazida do backend (`GET /api/cochos`,
 * ver `api/client.listarCochosNoBackend`) — é assim que a lista fica
 * compartilhada entre a equipe (ver `CochosScreen.carregarCochos`), com a
 * cópia local servindo de cache pra uso offline em campo.
 *
 * Regra: uma edição feita neste aparelho e ainda não sincronizada
 * (`sincronizado: false`) NUNCA é sobrescrita pelo que vem do servidor — o
 * próximo `sincronizarCochos()` que resolve isso, no sentido
 * aparelho -> backend. Um cocho já sincronizado antes, por outro lado, é
 * sempre atualizado com o que o servidor tem (inclui edições feitas por
 * outro aparelho) e é removido daqui se o servidor não o conhece mais
 * (excluído por outra pessoa da equipe) — a menos que já esteja na lista de
 * exclusões pendentes deste aparelho, caso em que a remoção local já
 * aconteceu e só falta a exclusão terminar de sincronizar.
 */
export async function mesclarComServidor(cochosDoServidor: CochoPayload[]): Promise<CochoRegistrado[]> {
  return withLock(async () => {
    const locais = await readRaw();
    const exclusoesPendentes = await readExclusoesRaw();
    const porId = new Map(locais.map((item) => [item.id, item]));

    for (const doServidor of cochosDoServidor) {
      if (exclusoesPendentes.includes(doServidor.id)) continue;
      const local = porId.get(doServidor.id);
      if (local && !local.sincronizado) continue; // edição local pendente vence, por ora
      porId.set(doServidor.id, {
        id: doServidor.id,
        nome: doServidor.nome,
        comprimentoCm: doServidor.comprimentoCm,
        larguraCm: doServidor.larguraCm,
        alturaCm: doServidor.alturaCm,
        experimento: doServidor.experimento,
        createdAt: local?.createdAt ?? Date.now(),
        sincronizado: true,
      });
    }

    const idsDoServidor = new Set(cochosDoServidor.map((item) => item.id));
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
