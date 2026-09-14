import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Updates from "expo-updates";
import { AnimatedDots } from "@/components/AnimatedDots";

/**
 * Aviso discreto, fixo na parte de baixo da tela, sobre o estado da
 * atualização OTA (`eas update`). Some sozinho quando não há nada relevante
 * acontecendo. Depende do `expo-updates` já instalado — nenhuma dependência
 * nova.
 */
export function UpdateBanner() {
  const insets = useSafeAreaInsets();
  const { isDownloading, isUpdatePending } = Updates.useUpdates();

  if (!isDownloading && !isUpdatePending) return null;

  const mensagem = isDownloading
    ? "Baixando atualização"
    : "Atualização baixada. Será aplicada na próxima vez que o app for aberto.";

  return (
    <View style={[styles.banner, { bottom: insets.bottom + 8 }]} pointerEvents="none">
      <View style={styles.linha}>
        <Text style={styles.texto}>{mensagem}</Text>
        {isDownloading && <AnimatedDots size={4} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: "absolute",
    left: 16,
    right: 16,
    backgroundColor: "#1B2530",
    borderWidth: 1,
    borderColor: "#3D8BFD",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  linha: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6 },
  texto: { color: "#F5F5F5", fontSize: 12, textAlign: "center" },
});
