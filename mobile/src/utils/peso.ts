/**
 * Validação/parsing do campo de peso, compartilhada entre a tela de
 * formulário (CaptureFormScreen) e a revisão editável da Prévia
 * (PreviewScreen) — as duas precisam da mesma regra pra não divergir.
 */
export function parsePesoInput(valor: string): number | null {
  const normalizado = valor.trim().replace(",", ".");
  if (!normalizado) return null;
  const numero = Number(normalizado);
  if (Number.isNaN(numero) || numero <= 0) return null;
  return numero;
}
