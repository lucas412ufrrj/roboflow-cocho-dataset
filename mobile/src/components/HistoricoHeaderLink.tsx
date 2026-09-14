import { Pressable, StyleSheet, Text, View } from "react-native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import type { RootStackParamList } from "@/navigation/RootNavigator";
import { usePendingCount } from "@/hooks/usePendingCount";

type Navegacao = NativeStackNavigationProp<RootStackParamList>;

/**
 * Link "Histórico" do cabeçalho da tela de nova captura, com uma bolinha
 * mostrando quantas capturas estão paradas na fila — pra dar pra notar uma
 * pendência sem precisar entrar no Histórico pra descobrir.
 */
export function HistoricoHeaderLink({ navigation }: { navigation: Navegacao }) {
  const pendentes = usePendingCount();

  return (
    <Pressable
      onPress={() => navigation.navigate("Historico")}
      hitSlop={10}
      style={styles.wrap}
    >
      <Text style={styles.texto}>Histórico</Text>
      {pendentes > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeTexto}>{pendentes > 9 ? "9+" : pendentes}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center", gap: 6, marginRight: 4 },
  texto: { color: "#3D8BFD", fontSize: 14, fontWeight: "700" },
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#FF6B6B",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  badgeTexto: { color: "#FFFFFF", fontSize: 10, fontWeight: "800" },
});
