import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CHANGELOG, type ChangelogEntry } from "@/data/changelog";

interface Props {
  visivel: boolean;
  onFechar: () => void;
}

interface GrupoPorData {
  data: string;
  itens: string[];
}

/**
 * Agrupa entradas do changelog pela data, na ordem em que aparecem — cada
 * atualização enviada no mesmo dia continua sendo uma entrada própria em
 * `CHANGELOG` (com sua própria `versao`, o que mantém o aviso de "tem
 * novidade" funcionando normalmente), mas aqui elas viram um só bloco na
 * tela, com a data escrita uma única vez.
 */
function agruparPorData(entradas: ChangelogEntry[]): GrupoPorData[] {
  const grupos: GrupoPorData[] = [];
  const indicePorData = new Map<string, number>();

  for (const entrada of entradas) {
    const indiceExistente = indicePorData.get(entrada.data);
    if (indiceExistente !== undefined) {
      grupos[indiceExistente].itens.push(...entrada.itens);
    } else {
      indicePorData.set(entrada.data, grupos.length);
      grupos.push({ data: entrada.data, itens: [...entrada.itens] });
    }
  }

  return grupos;
}

/** Tela cheia de novidades, mostrada na abertura do app quando há algo novo. */
export function ChangelogModal({ visivel, onFechar }: Props) {
  const insets = useSafeAreaInsets();
  const grupos = agruparPorData(CHANGELOG);

  return (
    <Modal visible={visivel} animationType="slide" onRequestClose={onFechar}>
      <View style={styles.container}>
        <Pressable
          style={[styles.botaoFechar, { top: insets.top + 12, right: 16 }]}
          onPress={onFechar}
          hitSlop={12}
        >
          <Text style={styles.botaoFecharTexto}>Fechar ✕</Text>
        </Pressable>

        <ScrollView contentContainerStyle={[styles.conteudo, { paddingTop: insets.top + 72 }]}>
          <Text style={styles.titulo}>Novidades</Text>
          {grupos.map((grupo) => (
            <View key={grupo.data} style={styles.bloco}>
              <Text style={styles.dataEntrada}>{grupo.data}</Text>
              {grupo.itens.map((item, indice) => (
                <Text key={indice} style={styles.item}>
                  •  {item}
                </Text>
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#101820" },
  botaoFechar: {
    position: "absolute",
    zIndex: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: "#1B2530",
    borderWidth: 1,
    borderColor: "#2A3542",
  },
  botaoFecharTexto: { color: "#F5F5F5", fontSize: 14, fontWeight: "600" },
  conteudo: { paddingHorizontal: 24, paddingBottom: 32, gap: 16 },
  titulo: { color: "#F5F5F5", fontSize: 24, fontWeight: "700", marginBottom: 8 },
  bloco: { gap: 6, marginBottom: 12 },
  dataEntrada: { color: "#3D8BFD", fontSize: 14, fontWeight: "700" },
  item: { color: "#D0D3D8", fontSize: 15, lineHeight: 22 },
});
