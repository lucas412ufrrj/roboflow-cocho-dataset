import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "@/navigation/RootNavigator";
import type { CaptureResponse, UploadPhase } from "@/types/capture";
import { ApiError, uploadCapture } from "@/api/client";

type Props = NativeStackScreenProps<RootStackParamList, "UploadStatus">;

export function UploadStatusScreen({ navigation, route }: Props) {
  const { form, video, captureId } = route.params;

  const [fase, setFase] = useState<UploadPhase>("idle");
  const [progresso, setProgresso] = useState(0);
  const [resultado, setResultado] = useState<CaptureResponse | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const iniciarEnvio = useCallback(async () => {
    setFase("enviando");
    setProgresso(0);
    setErro(null);
    setResultado(null);

    try {
      const resposta = await uploadCapture({
        captureId,
        video,
        form,
        onProgress: (fracao) => {
          setProgresso(fracao);
          if (fracao >= 1) setFase("processando");
        },
      });
      setResultado(resposta);
      setFase("concluido");
    } catch (error) {
      const mensagem =
        error instanceof ApiError ? error.message : "Falha inesperada ao enviar o vídeo.";
      setErro(mensagem);
      setFase("erro");
    }
  }, [captureId, video, form]);

  useEffect(() => {
    iniciarEnvio();
  }, [iniciarEnvio]);

  function novaCaptura() {
    navigation.popToTop();
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.captureIdLabel}>ID da captura</Text>
      <Text style={styles.captureId}>{captureId}</Text>

      {(fase === "enviando" || fase === "processando") && (
        <View style={styles.progressoBox}>
          <Text style={styles.status}>
            {fase === "enviando" ? "Enviando vídeo..." : "Processando no servidor..."}
          </Text>
          <View style={styles.barraFundo}>
            <View
              style={[
                styles.barraPreenchida,
                { width: `${Math.round((fase === "enviando" ? progresso : 1) * 100)}%` },
              ]}
            />
          </View>
          <Text style={styles.progressoTexto}>
            {fase === "enviando" ? `${Math.round(progresso * 100)}%` : "Extraindo e validando frames..."}
          </Text>
        </View>
      )}

      {fase === "erro" && (
        <View style={styles.erroBox}>
          <Text style={styles.erroTitulo}>Não foi possível concluir o envio</Text>
          <Text style={styles.erroTexto}>{erro}</Text>
          <Pressable style={styles.botao} onPress={iniciarEnvio}>
            <Text style={styles.botaoTexto}>Tentar novamente</Text>
          </Pressable>
        </View>
      )}

      {fase === "concluido" && resultado && (
        <View style={styles.resultadoBox}>
          <Text style={styles.status}>Captura concluída ✅</Text>
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
});
