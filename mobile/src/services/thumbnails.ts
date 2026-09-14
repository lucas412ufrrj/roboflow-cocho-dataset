/**
 * Miniatura (thumbnail) de cada vídeo capturado, guardada numa pasta própria
 * e durável — separada da fila de envio. O vídeo original é apagado do
 * aparelho assim que o envio termina com sucesso (ver
 * `offlineQueue.removeFromQueue`), mas a miniatura precisa continuar
 * existindo pra identificar a captura no Histórico bem depois disso.
 */
import * as FileSystem from "expo-file-system/legacy";
import * as VideoThumbnails from "expo-video-thumbnails";

const THUMBS_DIR = `${FileSystem.documentDirectory}historico-thumbs/`;

function caminhoMiniatura(captureId: string): string {
  return `${THUMBS_DIR}${captureId}.jpg`;
}

async function ensureThumbsDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(THUMBS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(THUMBS_DIR, { intermediates: true });
  }
}

/**
 * Gera a miniatura de um vídeo recém-capturado. Nunca lança — uma miniatura
 * que falhou (formato inesperado, pouco espaço) não pode impedir o envio de
 * verdade; a linha do Histórico simplesmente fica sem imagem, como já
 * acontecia antes desta função existir.
 */
export async function gerarMiniatura(captureId: string, videoUri: string): Promise<string | undefined> {
  try {
    await ensureThumbsDir();
    // time em ms: meio segundo em vez do frame 0, que em alguns vídeos ainda
    // pega uma transição escura/em branco da câmera.
    const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, { time: 500, quality: 0.6 });
    const destino = caminhoMiniatura(captureId);
    await FileSystem.copyAsync({ from: uri, to: destino });
    FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined); // temporário do gerador
    return destino;
  } catch {
    return undefined;
  }
}

/** Remove a miniatura de uma captura — usado quando a entrada correspondente
 * sai do Histórico (cortada pelo limite de entradas antigas). Housekeeping
 * só: uma falha aqui não afeta nada além de deixar um arquivo órfão. */
export async function removerMiniatura(captureId: string): Promise<void> {
  try {
    const caminho = caminhoMiniatura(captureId);
    const info = await FileSystem.getInfoAsync(caminho);
    if (info.exists) {
      await FileSystem.deleteAsync(caminho, { idempotent: true });
    }
  } catch {
    // limpeza é só housekeeping — nunca deve quebrar nada
  }
}
