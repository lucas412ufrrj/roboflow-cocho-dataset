import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "@/navigation/RootNavigator";
import type { CaptureResponse } from "@/types/capture";
import { getQueueItem, type QueueItem } from "@/services/offlineQueue";
import { sincronizarItem, subscribeQueueChanges, temWifiConectado } from "@/services/syncEngine";
import { AnimatedDots } from "@/components/AnimatedDots";

type Props = NativeStackScreenProps<RootStackParamList, "UploadStatus">;

type TelaFase = "verificando" | "aguardando_wifi" | "enviando" | "concluido" | "erro";

export function UploadStatusScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { captureId } = route.params;

  const [fase, setFase] = useState<TelaFase>("verificando");
  const [progresso, setProgresso] = useState(0);
  const [resultado, setResultado] = useState<CaptureResponse | null>(null);
  const [itemFila, setItemFila] = useState<QueueItem | null>(null);

  const tentarEnviar = useCallback(async () => {
    setFase("enviando");
    setProgresso(0);
    try {
      const resposta = await sincronizarItem(captureId, (fracao) =>
        setProgresso(Math.min(fracao, 1))
      );
      if (resposta) {
        setResultado(resposta);
        setFase("concluido");
        return;
      }
      const item = await getQueueItem(captureId);
      if (!item) {
        // Já foi enviada por outro gatilho (ex.: sincronização automática)
        // enquanto esta tentativa estava em andamento.
        setFase("concluido");
        return;
      }
      setItemFila(item);
      setFase("erro");
    } catch (erro) {
      // Não deveria acontecer (sincronizarItem já trata os próprios erros),
      // mas se algo inesperado escapar, mostra erro em vez de travar a tela.
      console.log("[UploadStatusScreen] erro inesperado ao tentar enviar:", erro);
      const item = await getQueueItem(captureId).catch(() => undefined);
      if (item) setItemFila(item);
      setFase("erro");
    }
  }, [captureId]);

  useEffect(() => {
    let cancelado = false;

    async function iniciar() {
      try {
        const item = await getQueueItem(captureId);
        if (!item) {
          if (!cancelado) setFase("concluido");
          return;
        }
        const temWifi = await temWifiConectado();
        if (!temWifi) {
          if (!cancelado) {
            setItemFila(item);
            setFase("aguardando_wifi");
          }
          return;
        }
        if (!cancelado) await tentarEnviar();
      } catch (erro) {
        // Qualquer falha ao verificar a fila ou a conexão cai no lado seguro:
        // trata como "sem wifi" em vez de deixar a tela presa em
        // "Verificando...". O vídeo continua salvo e os gatilhos automáticos
        // tentam de novo depois.
        console.log("[UploadStatusScreen] erro ao verificar fila/conexão:", erro);
        if (!cancelado) setFase("aguardando_wifi");
      }
    }

    iniciar();

    const cancelarAssinatura = subscribeQueueChanges(() => {
      if (cancelado) return;
      getQueueItem(captureId).then((item) => {
        if (cancelado) return;
        if (!item) {
          setFase("concluido");
        } else {
          setItemFila(item);
        }
      });
    });

    return () => {
      cancelado = true;
      cancelarAssinatura();
    };
  }, [captureId, tentarEnviar]);

  function novaCaptura() {
    navigation.popToTop();
  }

  return (
    <ScrollView contentContainerStyle={[styles.container, { paddingBottom: 20 + insets.bottom }]}>
      <Text style={styles.captureIdLabel}>ID da captura</Text>
      <Text style={styles.captureId}>{captureId}</Text>

      {fase === "verificando" && <Text style={styles.status}>Verificando...</Text>}

      {fase === "aguardando_wifi" && (
        <View style={styles.progressoBox}>
          <Text style={styles.status}>Vídeo salvo no aparelho</Text>
          <Text style={styles.progressoTexto}>
            Sem wifi no momento. O envio acontece automaticamente assim que houver conexão wifi —
            não precisa reabrir o app nem tentar de novo. Se preferir, também dá para reenviar
            manualmente a qualquer momento pela aba Histórico.
          </Text>
          <Pressable style={styles.botao} onPress={novaCaptura}>
            <Text style={styles.botaoTexto}>Nova captura</Text>
          </Pressable>
        </View>
      )}

      {fase === "enviando" && (
        <View style={styles.progressoBox}>
          <View style={styles.linhaStatus}>
            <Text style={styles.status}>
              {progresso >= 1 ? "Processando no servidor" : "Enviando vídeo"}
            </Text>
            <AnimatedDots />
          </View>
          <View style={styles.barraFundo}>
            <View
              style={[
                styles.barraPreenchida,
                { width: `${Math.round(Math.min(progresso, 1) * 100)}%` },
              ]}
            />
          </View>
          <Text style={styles.progressoTexto}>
            {progresso >= 1
              ? "Vídeo enviado, aguardando o processamento terminar..."
              : `${Math.round(progresso * 100)}%`}
          </Text>
        </View>
      )}

      {fase === "erro" && (
        <View style={styles.erroBox}>
          <Text style={styles.erroTitulo}>Não foi possível concluir o envio agora</Text>
          <Text style={styles.erroTexto}>{itemFila?.lastError ?? "Falha desconhecida."}</Text>
          <Text style={styles.progressoTexto}>
            O vídeo continua salvo no aparelho. Além da nova tentativa automática assim que houver
            wifi, também dá para reenviar manualmente pela aba Histórico a qualquer momento.
          </Text>
          <Pressable style={styles.botao} onPress={tentarEnviar}>
            <Text style={styles.botaoTexto}>Tentar novamente agora</Text>
          </Pressable>
          <Pressable style={styles.botaoSecundario} onPress={novaCaptura}>
            <Text style={styles.botaoSecundarioTexto}>Nova captura</Text>
          </Pressable>
        </View>
      )}

      {fase === "concluido" && (
        <View style={styles.resultadoBox}>
          <Text style={styles.status}>Captura concluída ✅</Text>
          {resultado ? (
            <>
              {resultado.idempotente_reprocessado && (
                <Text style={styles.avisoIdempotente}>
                  Este vídeo já havia sido processado anteriormente — nenhum frame duplicado foi
                  enviado.
                </Text>
              )}

              <View style={styles.linhaResumo}>
                <Text style={styles.resumoLabel}>Split</Text>
                <Text style={styles.resumoValor}>{resultado.split}</Text>
              </View>
              <View style={styles.linhaResumo}>
                <Text style={styles.resumoLabel}>Frames candidatos</Text>
                <Text style={styles.resumoValor}>{resultado.total_candidatos}</Text>
              </View>
              <View style={styles.linhaResumo}>
                <Text style={[styles.resumoValor, styles.corAprovado]}>Aprovados</Text>
                <Text style={[styles.resumoValor, styles.corAprovado]}>{resultado.total_aprovados}</Text>
              </View>
              <View style={styles.linhaResumo}>
                <Text style={styles.resumoLabel}>Rejeitados por desfoque</Text>
                <Text style={styles.resumoValor}>{resultado.total_rejeitados_desfoque}</Text>
              </View>
              <View style={styles.linhaResumo}>
                <Text style={styles.resumoLabel}>Rejeitados (cocho incompleto)</Text>
                <Text style={styles.resumoValor}>{resultado.total_rejeitados_cocho_incompleto}</Text>
              </View>
              <View style={styles.linhaResumo}>
                <Text style={[styles.resumoLabel, styles.corFalha]}>Falhas de upload</Text>
                <Text style={[styles.resumoValor, styles.corFalha]}>{resultado.total_falhas_upload}</Text>
              </View>

              <Text style={styles.subtitulo}>Detalhe por frame</Text>
              {resultado.frames.map((frame) => (
                <View key={frame.frame_index} style={styles.frameLinha}>
                  <Text style={styles.frameTexto}>
                    #{frame.frame_index} · {frame.frame_time_ms}ms · foco {frame.focus_score.toFixed(0)}
                  </Text>
                  <Text style={[styles.frameStatus, statusStyle(frame.status)]}>
                    {statusLabel(frame.status)}
                  </Text>
                </View>
              ))}
            </>
          ) : (
            <Text style={styles.progressoTexto}>
              O vídeo já foi enviado — a sincronização aconteceu em segundo plano, então o detalhe
              por frame não ficou disponível nesta tela.
            </Text>
          )}

          <Pressable style={styles.botao} onPress={novaCaptura}>
            <Text style={styles.botaoTexto}>Nova captura</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "aprovado":
      return "Aprovado";
    case "rejeitado_desfoque":
      return "Desfocado";
    case "rejeitado_cocho_incompleto":
      return "Cocho incompleto";
    case "falha_upload":
      return "Falha no envio";
    default:
      return status;
  }
}

function statusStyle(status: string) {
  switch (status) {
    case "aprovado":
      return { color: "#3DDC97" };
    case "falha_upload":
      return { color: "#FF6B6B" };
    default:
      return { color: "#FFB020" };
  }
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 16 },
  captureIdLabel: { color: "#8A8F98", fontSize: 12 },
  captureId: { color: "#D0D3D8", fontSize: 13, marginBottom: 8, fontFamily: "monospace" },
  status: { color: "#F5F5F5", fontSize: 17, fontWeight: "700" },
  linhaStatus: { flexDirection: "row", alignItems: "center", gap: 8 },
  progressoBox: { gap: 10 },
  barraFundo: { height: 10, borderRadius: 6, backgroundColor: "#1B2530", overflow: "hidden" },
  barraPreenchida: { height: 10, backgroundColor: "#3D8BFD" },
  progressoTexto: { color: "#B5B9C0", fontSize: 13 },
  erroBox: { gap: 12 },
  erroTitulo: { color: "#FF6B6B", fontSize: 17, fontWeight: "700" },
  erroTexto: { color: "#D0D3D8", fontSize: 14 },
  resultadoBox: { gap: 10 },
  avisoIdempotente: { color: "#FFB020", fontSize: 13 },
  linhaResumo: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  resumoLabel: { color: "#B5B9C0", fontSize: 14 },
  resumoValor: { color: "#F5F5F5", fontSize: 14, fontWeight: "600" },
  corAprovado: { color: "#3DDC97" },
  corFalha: { color: "#FF6B6B" },
  subtitulo: { color: "#F5F5F5", fontSize: 15, fontWeight: "700", marginTop: 12 },
  frameLinha: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#1B2530",
    paddingVertical: 6,
  },
  frameTexto: { color: "#B5B9C0", fontSize: 12 },
  frameStatus: { fontSize: 12, fontWeight: "700" },
  botao: {
    marginTop: 20,
    backgroundColor: "#3D8BFD",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
  },
  botaoTexto: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  botaoSecundario: {
    marginTop: 12,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#3D8BFD",
  },
  botaoSecundarioTexto: { color: "#3D8BFD", fontSize: 15, fontWeight: "600" },
});
