import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { subscribeBuildDesatualizada } from "@/services/buildCheck";

/**
 * Aviso fixo no topo da tela, em qualquer aba, pra quem estiver numa build
 * nativa mais antiga que a recomendada (ver `services/buildCheck.ts`). Fica
 * no topo (o `UpdateBanner`, de atualização OTA, fica embaixo) pra nunca
 * sobrepor os dois. Não bloqueia nada — a pessoa continua usando o app
 * normalmente, só fica ciente do risco de continuar numa versão antiga.
 */
export function OutdatedBuildBanner() {
  const insets = useSafeAreaInsets();
  const [desatualizada, setDesatualizada] = useState(false);

  useEffect(() => subscribeBuildDesatualizada(setDesatualizada), []);

  if (!desatualizada) return null;

  return (
    <View style={[styles.banner, { top: insets.top + 8 }]} pointerEvents="none">
      <Text style={styles.titulo}>Seu app está numa versão antiga</Text>
      <Text style={styles.texto}>
        Peça a build mais nova pra quem cuida do app e instale assim que possível. Uma versão
        antiga pode travar no meio de um envio, mostrar informação desatualizada ou parar de
        funcionar sem aviso.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: "absolute",
    left: 16,
    right: 16,
    backgroundColor: "#2A1F10",
    borderWidth: 1,
    borderColor: "#FFB020",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 4,
  },
  titulo: { color: "#FFB020", fontSize: 13, fontWeight: "700" },
  texto: { color: "#F5F5F5", fontSize: 12, lineHeight: 16 },
});
