import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "@/navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "CaptureForm">;

export function CaptureFormScreen({ navigation }: Props) {
  const [pesoKg, setPesoKg] = useState("");
  const [tipoAlimento, setTipoAlimento] = useState("");
  const [cochoId, setCochoId] = useState("");
  const [observacoes, setObservacoes] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  function validarPeso(valor: string): number | null {
    const normalizado = valor.trim().replace(",", ".");
    if (!normalizado) return null;
    const numero = Number(normalizado);
    if (Number.isNaN(numero) || numero <= 0) return null;
    return numero;
  }

  function continuar() {
    const numero = validarPeso(pesoKg);
    if (numero === null) {
      setErro("Informe o peso real em kg (ex.: 12.5).");
      return;
    }
    setErro(null);
    navigation.navigate("RecordVideo", {
      form: {
        pesoKg,
        tipoAlimento: tipoAlimento.trim() || undefined,
        cochoId: cochoId.trim() || undefined,
        observacoes: observacoes.trim() || undefined,
      },
    });
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.titulo}>Dados da pesagem</Text>
        <Text style={styles.subtitulo}>
          Preencha o peso real do alimento no cocho antes de gravar o vídeo.
        </Text>

        <Text style={styles.label}>Peso real (kg) *</Text>
        <TextInput
          style={styles.input}
          value={pesoKg}
          onChangeText={setPesoKg}
          placeholder="Ex.: 12.5"
          placeholderTextColor="#8A8F98"
          keyboardType="decimal-pad"
        />

        <Text style={styles.label}>Tipo de alimento (opcional)</Text>
        <TextInput
          style={styles.input}
          value={tipoAlimento}
          onChangeText={setTipoAlimento}
          placeholder="Ex.: Silagem, Ração"
          placeholderTextColor="#8A8F98"
        />

        <Text style={styles.label}>ID do cocho (opcional)</Text>
        <TextInput
          style={styles.input}
          value={cochoId}
          onChangeText={setCochoId}
          placeholder="Ex.: cocho-07"
          placeholderTextColor="#8A8F98"
        />

        <Text style={styles.label}>Observações (opcional)</Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          value={observacoes}
          onChangeText={setObservacoes}
          placeholder="Alguma observação sobre esta captura?"
          placeholderTextColor="#8A8F98"
          multiline
          numberOfLines={3}
        />

        {erro && <Text style={styles.erro}>{erro}</Text>}

        <Pressable style={styles.botao} onPress={continuar}>
          <Text style={styles.botaoTexto}>Continuar para gravação</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 4 },
  titulo: { color: "#F5F5F5", fontSize: 22, fontWeight: "700", marginBottom: 4 },
  subtitulo: { color: "#B5B9C0", fontSize: 14, marginBottom: 20 },
  label: { color: "#D0D3D8", fontSize: 14, marginTop: 14, marginBottom: 6, fontWeight: "600" },
  input: {
    backgroundColor: "#1B2530",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#F5F5F5",
    fontSize: 16,
    borderWidth: 1,
    borderColor: "#2A3542",
  },
  textArea: { minHeight: 80, textAlignVertical: "top" },
  erro: { color: "#FF6B6B", marginTop: 14 },
  botao: {
    marginTop: 28,
    backgroundColor: "#3D8BFD",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
  },
  botaoTexto: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
});
