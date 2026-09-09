import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "@/navigation/RootNavigator";
import { formatDuration, formatFileSize, isDurationValid, MAX_DURATION_S, MIN_DURATION_S } from "@/utils/video";
import { generateCaptureId } from "@/utils/uuid";

type Props = NativeStackScreenProps<RootStackParamList, "Preview">;

export function PreviewScreen({ navigation, route }: Props) {
  const { form, video } = route.params;
  const [durationMs, setDurationMs] = useState(video.durationMs);
  const [duracaoCarregada, setDuracaoCarregada] = useState(false);

  const player = useVideoPlayer(video.uri, (p) => {
    p.loop = false;
  });

  const { status } = useEvent(player, "statusChange", { status: player.status });

  useEffect(() => {
    if (status === "readyToPlay" && !duracaoCarregada && player.duration) {
      setDurationMs(player.duration * 1000);
      setDuracaoCarregada(true);
    }
  }, [status, duracaoCarregada, player.duration]);

  const duracaoValida = duracaoCarregada && isDurationValid(durationMs);

  function confirmarEEnviar() {
    if (!duracaoCarregada) {
      Alert.alert("Aguarde", "Carregando informações do vídeo...");
      return;
    }
    if (!duracaoValida) {
      Alert.alert(
        "Duração inválida",
        `O vídeo precisa ter entre ${MIN_DURATION_S} e ${MAX_DURATION_S} segundos. ` +
          `Duração atual: ${formatDuration(durationMs)}. Grave ou selecione novamente.`
      );
      return;
    }

    const captureId = generateCaptureId();
    navigation.navigate("UploadStatus", {
      form,
      video: { ...video, durationMs },
      captureId,
    });
  }

  return (
    <View style={styles.container}>
      <View style={styles.playerWrapper}>
        <VideoView style={styles.player} player={player} nativeControls contentFit="contain" />
      </View>

      <View style={styles.infoBox}>
        <View style={styles.infoLinha}>
          <Text style={styles.infoLabel}>Duração</Text>
          <Text style={[styles.infoValor, duracaoCarregada && !duracaoValida && styles.infoInvalida]}>
            {duracaoCarregada ? formatDuration(durationMs) : "Carregando..."}
          </Text>
        </View>
        <View style={styles.infoLinha}>
          <Text style={styles.infoLabel}>Tamanho</Text>
          <Text style={styles.infoValor}>{formatFileSize(video.sizeBytes)}</Text>
        </View>
        <View style={styles.infoLinha}>
          <Text style={styles.infoLabel}>Peso informado</Text>
          <Text style={styles.infoValor}>{form.pesoKg} kg</Text>
        </View>
      </View>

      {duracaoCarregada && !duracaoValida && (
        <Text style={styles.aviso}>
          Duração fora do intervalo de {MIN_DURATION_S}–{MAX_DURATION_S}s. Grave novamente.
        </Text>
      )}

      <View style={styles.botoesLinha}>
        <Pressable style={styles.botaoSecundario} onPress={() => navigation.goBack()}>
          <Text style={styles.botaoSecundarioTexto}>Regravar</Text>
        </Pressable>
        <Pressable
          style={[styles.botao, !duracaoValida && styles.botaoDesabilitado]}
          onPress={confirmarEEnviar}
          disabled={!duracaoValida}
        >
          <Text style={styles.botaoTexto}>Enviar captura</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 16 },
  playerWrapper: { flex: 1, borderRadius: 14, overflow: "hidden", backgroundColor: "#000" },
  player: { flex: 1 },
  infoBox: { backgroundColor: "#1B2530", borderRadius: 12, padding: 16, gap: 10 },
  infoLinha: { flexDirection: "row", justifyContent: "space-between" },
  infoLabel: { color: "#B5B9C0", fontSize: 14 },
  infoValor: { color: "#F5F5F5", fontSize: 14, fontWeight: "600" },
  infoInvalida: { color: "#FF6B6B" },
  aviso: { color: "#FFB020", fontSize: 13 },
  botoesLinha: { flexDirection: "row", gap: 12 },
  botao: {
    flex: 1,
    backgroundColor: "#3D8BFD",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
  },
  botaoDesabilitado: { backgroundColor: "#354456" },
  botaoTexto: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  botaoSecundario: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#3D8BFD",
  },
  botaoSecundarioTexto: { color: "#3D8BFD", fontSize: 16, fontWeight: "600" },
});
