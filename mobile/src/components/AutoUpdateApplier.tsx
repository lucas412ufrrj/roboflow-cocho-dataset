import { useEffect, useRef } from "react";
import * as Updates from "expo-updates";

import { obterRotaAtual, subscribeRotaAtual } from "@/services/navigationTracker";

/**
 * Telas "paradas", onde reiniciar o app na hora não atrapalha nada — nunca
 * inclui RecordVideo, Preview, CaptureForm ou UploadStatus, que têm dado
 * não salvo (vídeo gravando, formulário preenchido, envio em andamento).
 */
const TELAS_SEGURAS = new Set(["Lobby", "Historico", "Sobre"]);

function telaSegura(rota: string | undefined): boolean {
  return rota === undefined || TELAS_SEGURAS.has(rota);
}

/**
 * Aplica a atualização OTA sozinha assim que termina de baixar, sem
 * depender da pessoa fechar e abrir o app de novo (o padrão do
 * `expo-updates` só troca o JS na próxima abertura — daí o "precisa abrir
 * duas vezes"). Continua mostrando o aviso de `UpdateBanner.tsx` enquanto
 * isso, mas assim que `isUpdatePending` fica true:
 *
 * - se a pessoa estiver numa tela parada (Lobby/Histórico/Sobre), reinicia
 *   na hora;
 * - se estiver no meio de uma gravação, formulário ou envio, espera ela
 *   voltar pra uma tela segura antes de reiniciar, pra não perder nada que
 *   estivesse fazendo.
 *
 * Não renderiza nada — só efeito colateral, igual ao resto dos serviços
 * "de fundo" do app (`buildCheck.ts`, `syncEngine.ts`).
 */
export function AutoUpdateApplier() {
  const { isUpdatePending } = Updates.useUpdates();
  const aplicandoRef = useRef(false);

  useEffect(() => {
    if (!isUpdatePending || aplicandoRef.current) return;

    function tentarAplicar(rota: string | undefined) {
      if (aplicandoRef.current || !telaSegura(rota)) return;
      aplicandoRef.current = true;
      Updates.reloadAsync().catch(() => {
        // Falhou por algum motivo raro (ex.: sem storage) — o aviso
        // normal do UpdateBanner continua valendo como plano B.
        aplicandoRef.current = false;
      });
    }

    tentarAplicar(obterRotaAtual());
    return subscribeRotaAtual(tentarAplicar);
  }, [isUpdatePending]);

  return null;
}
