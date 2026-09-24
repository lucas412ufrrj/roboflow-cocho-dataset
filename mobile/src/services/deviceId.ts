/**
 * Identificador estável desta instalação do app — gerado uma vez, guardado
 * em disco, e mandado como header `X-Device-Id` em toda chamada ao backend
 * (ver `api/client.ts`). Não é login: não pede nada de ninguém, não trava
 * nenhuma tela, não identifica a pessoa — só a INSTALAÇÃO do app. Resolve
 * dois problemas que a falta de identidade por aparelho vinha causando:
 *
 * - Diagnóstico: hoje, saber que uma captura falhou depende de alguém
 *   mandar print — não existe nenhum jeito de olhar os logs do Render e
 *   saber QUAL aparelho gerou qual requisição. Com este id nos logs do
 *   backend, dá pra correlacionar sem precisar perguntar (ver
 *   `core/security.py` e os logs em `api/captures.py`/`api/chunked_uploads.py`).
 * - O limitador de taxa do backend (`RATE_LIMIT_CAPTURES`/`RATE_LIMIT_CHUNKS`,
 *   ver `core/security.py`) era só por endereço IP — a equipe inteira atrás
 *   do mesmo wifi/hotspot em campo dividia o MESMO limite, então uma pessoa
 *   testando bastante podia fazer a requisição de outra, num aparelho
 *   totalmente diferente, levar 429 sem ter feito nada de errado. Com este
 *   id, o backend passa a limitar por aparelho.
 *
 * Não usa nenhum identificador de hardware (Android ID, IMEI, etc.) de
 * propósito — só um UUID aleatório gerado localmente, sem vínculo nenhum
 * com a pessoa ou o aparelho fora deste app. Reinstalar o app gera um id
 * novo, mesma limitação que qualquer outro dado local do app já tem.
 */
import * as FileSystem from "expo-file-system/legacy";
import * as Crypto from "expo-crypto";

const ARQUIVO_DEVICE_ID = `${FileSystem.documentDirectory}device_id.json`;

let deviceIdEmMemoria: string | null = null;
let carregamentoEmAndamento: Promise<string> | null = null;

async function lerOuCriarDeviceId(): Promise<string> {
  try {
    const info = await FileSystem.getInfoAsync(ARQUIVO_DEVICE_ID);
    if (info.exists) {
      const raw = await FileSystem.readAsStringAsync(ARQUIVO_DEVICE_ID);
      const parsed = JSON.parse(raw) as { deviceId?: string };
      if (parsed.deviceId) return parsed.deviceId;
    }
  } catch {
    // Arquivo corrompido ou ilegível — cai no caminho de gerar um novo
    // abaixo em vez de propagar erro (isto é só diagnóstico, nunca deve
    // impedir um envio).
  }
  const novoId = Crypto.randomUUID();
  try {
    await FileSystem.writeAsStringAsync(ARQUIVO_DEVICE_ID, JSON.stringify({ deviceId: novoId }));
  } catch {
    // Se não conseguir persistir, segue com o id só em memória nesta
    // sessão do app — melhor mandar um id que muda entre aberturas do que
    // travar um envio por causa de diagnóstico.
  }
  return novoId;
}

/**
 * Devolve o id desta instalação, gerando e salvando na primeira chamada e
 * reaproveitando da memória depois disso — nunca lê o disco de novo depois
 * da primeira vez em cada abertura do app.
 */
export function obterDeviceId(): Promise<string> {
  if (deviceIdEmMemoria) return Promise.resolve(deviceIdEmMemoria);
  if (!carregamentoEmAndamento) {
    carregamentoEmAndamento = lerOuCriarDeviceId().then((id) => {
      deviceIdEmMemoria = id;
      return id;
    });
  }
  return carregamentoEmAndamento;
}
