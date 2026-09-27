/**
 * Validação/parsing do campo de peso, compartilhada entre a tela de
 * formulário (CaptureFormScreen), a revisão editável da Prévia
 * (PreviewScreen) e a edição de uma captura já na fila (EditCaptureScreen) —
 * as três precisam da mesma regra pra não divergir.
 *
 * `PESO_MIN_KG`/`PESO_MAX_KG` espelham `MIN_PESO_KG`/`MAX_PESO_KG` em
 * `backend/app/config.py` — o backend segue sendo a fonte da verdade (nunca
 * confia só nesta checagem do aparelho), mas sem isso um erro de digitação
 * (ex.: "25000" em vez de "250") só aparecia como falha de envio bem depois,
 * quando o vídeo já tinha sido gravado e a pessoa já tinha ido pro próximo
 * cocho — tarde demais pra corrigir na hora.
 */
export const PESO_MIN_KG = 0.01;
export const PESO_MAX_KG = 2000;

export function parsePesoInput(valor: string): number | null {
  const normalizado = valor.trim().replace(",", ".");
  if (!normalizado) return null;
  const numero = Number(normalizado);
  if (Number.isNaN(numero) || numero < PESO_MIN_KG || numero > PESO_MAX_KG) return null;
  return numero;
}

/**
 * Mensagem de erro pronta pra mostrar embaixo do campo de peso — cobre tanto
 * um valor inválido/vazio quanto um número tecnicamente válido mas fora da
 * faixa que o backend aceita, com uma mensagem específica pra cada caso
 * (ver comentário acima). `null` quando o valor está OK — use isso pra
 * decidir se pode continuar, não `parsePesoInput(...) === null` sozinho,
 * que não diz QUAL foi o problema.
 */
export function erroDoPeso(valor: string): string | null {
  const normalizado = valor.trim().replace(",", ".");
  if (!normalizado) return "Informe o peso real em kg (ex.: 12.5).";
  const numero = Number(normalizado);
  if (Number.isNaN(numero)) return "Peso inválido. Use um número, ex.: 12.5.";
  if (numero <= 0) return "O peso precisa ser maior que zero.";
  if (numero > PESO_MAX_KG) {
    return `Peso muito alto (máximo aceito: ${PESO_MAX_KG} kg). Confira se não sobrou um dígito a mais.`;
  }
  return null;
}
