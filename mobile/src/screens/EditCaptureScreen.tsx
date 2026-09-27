import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "@/navigation/RootNavigator";
import type { CaptureFormData } from "@/types/capture";
import { erroDoPeso } from "@/utils/peso";
import { getQueueItem, updateQueueItem } from "@/services/offlineQueue";
import { atualizarNoHistorico } from "@/services/historicoEnvios";

type Props = NativeStackScreenProps<RootStackParamList, "EditCapture">;

/**
 * Edita peso e observações de uma captura que ainda está na fila local
 * (aguardando envio) — aberta pelo menu (⋮) de um item do Histórico
 * (`HistoricoScreen.tsx`), só quando ele ainda não está sendo enviado.
 *
 * `cocho` e `tipoAlimento` não são editáveis aqui de propósito: são
 * selecionados ANTES de gravar (`CochosScreen` -> `TiposAlimentoScreen`) e
 * mudar qualquer um dos dois depois abriria a questão de qual vídeo eles se
 * referem — mesma decisão já tomada na revisão da Prévia (`PreviewScreen`).
 * Peso e observações, por outro lado, são erros de digitação comuns (ex.:
 * "250" digitado como "2500") sem nenhuma relação com o vídeo em si, então
 * corrigir aqui evita ter que cancelar e regravar tudo de novo.
 */
export function EditCaptureScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { captureId } = route.params;

  const [carregando, setCarregando] = useState(true);
  const [naoEncontrada, setNaoEncontrada] = useState(false);
  const [form, setForm] = useState<CaptureFormData | null>(null);
  const [pesoKg, setPesoKg] = useState("");
  const [observacoes, setObservacoes] = useState("");
  const [erroPeso, setErroPeso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let ativo = true;
      getQueueItem(captureId).then((item) => {
        if (!ativo) return;
        if (!item) {
          setNaoEncontrada(true);
          setCarregando(false);
          return;
        }
        setForm(item.form);
        setPesoKg(item.form.pesoKg);
        setObservacoes(item.form.observacoes ?? "");
        setCarregando(false);
      });
      return () => {
        ativo = false;
      };
    }, [captureId])
  );

  // Validação em tempo real, mesmo motivo de `CaptureFormScreen`/`PreviewScreen`
  // (ver `utils/peso.ts`): sem isso, um peso fora da faixa só apareceria como
  // falha de envio bem mais tarde.
  const erroPesoAoVivo = pesoKg.length > 0 ? erroDoPeso(pesoKg) : null;

  async function salvar() {
    const mensagemErro = erroDoPeso(pesoKg);
    if (mensagemErro) {
      setErroPeso(mensagemErro);
      return;
    }
    if (!form) return;

    setSalvando(true);
    try {
      // Reconfere o estado ATUAL da fila antes de gravar — entre abrir esta
      // tela e tocar em "Salvar" um gatilho automático (wifi conectando,
      // sincronização periódica) pode ter começado a enviar este mesmo vídeo,
      // ou até terminado. Gravar por cima nesse caso seria uma corrida real:
      // a edição podia se perder (envio já em andamento com os dados
      // antigos) ou, pior, sobrescrever um item que nem existe mais.
      const atual = await getQueueItem(captureId);
      if (!atual) {
        Alert.alert(
          "Não deu pra salvar",
          "Essa captura não está mais aguardando envio (já foi enviada ou cancelada)."
        );
        navigation.goBack();
        return;
      }
      if (atual.status !== "pendente") {
        Alert.alert(
          "Não deu pra salvar agora",
          "O envio desse vídeo já começou. Espere terminar (ou falhar) e edite de novo antes da próxima tentativa."
        );
        navigation.goBack();
        return;
      }

      const formAtualizado: CaptureFormData = {
        ...atual.form,
        pesoKg: pesoKg.trim(),
        observacoes: observacoes.trim() || undefined,
      };
      await updateQueueItem(captureId, { form: formAtualizado });
      // Histórico é só exibição — atraso ou falha aqui não desfaz a edição
      // de verdade, que já está salva na fila.
      await atualizarNoHistorico(captureId, { pesoKg: formAtualizado.pesoKg }).catch(() => undefined);
      navigation.goBack();
    } catch {
      Alert.alert("Erro ao salvar", "Não foi possível salvar as alterações. Tente novamente.");
    } finally {
      setSalvando(false);
    }
  }

  if (carregando) {
    return (
      <View style={styles.centralizado}>
        <ActivityIndicator color="#3D8BFD" />
      </View>
    );
  }

  if (naoEncontrada || !form) {
    return (
      <View style={styles.centralizado}>
        <Text style={styles.avisoTexto}>
          Essa captura não está mais aguardando envio (já foi enviada ou cancelada).
        </Text>
        <Pressable style={styles.botaoSecundario} onPress={() => navigation.goBack()}>
          <Text style={styles.botaoSecundarioTexto}>Voltar</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: 20 + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.infoBox}>
          <View style={styles.infoLinha}>
            <Text style={styles.infoLabel}>Cocho</Text>
            <Text style={styles.infoValor} numberOfLines={1}>
              {form.cocho.nome}
            </Text>
          </View>
          <View style={styles.infoLinha}>
            <Text style={styles.infoLabel}>Tipo de alimento</Text>
            <Text style={styles.infoValor} numberOfLines={1}>
              {form.tipoAlimento.nome}
            </Text>
          </View>
        </View>
        <Text style={styles.avisoCampoFixo}>
          Cocho e tipo de alimento não são editáveis aqui — cancele e regrave se algum dos dois estiver errado.
        </Text>

        <Text style={styles.label}>Peso real (kg) *</Text>
        <TextInput
          style={[styles.input, erroPesoAoVivo && styles.inputComErro]}
          value={pesoKg}
          onChangeText={(v: string) => {
            setPesoKg(v);
            setErroPeso(null);
          }}
          placeholder="Ex.: 12.5"
          placeholderTextColor="#8A8F98"
          keyboardType="decimal-pad"
        />
        {(erroPesoAoVivo || erroPeso) && <Text style={styles.erro}>{erroPesoAoVivo ?? erroPeso}</Text>}

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

        <Pressable
          style={[styles.botao, (!!erroPesoAoVivo || salvando) && styles.botaoDesabilitado]}
          onPress={salvar}
          disabled={!!erroPesoAoVivo || salvando}
        >
          <Text style={styles.botaoTexto}>{salvando ? "Salvando..." : "Salvar alterações"}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 4 },
  centralizado: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  avisoTexto: { color: "#B5B9C0", fontSize: 14, textAlign: "center" },
  infoBox: { backgroundColor: "#1B2530", borderRadius: 12, padding: 16, gap: 10, marginBottom: 4 },
  infoLinha: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  infoLabel: { color: "#B5B9C0", fontSize: 14 },
  infoValor: { color: "#F5F5F5", fontSize: 14, fontWeight: "600", flexShrink: 1 },
  avisoCampoFixo: { color: "#8A8F98", fontSize: 12, marginBottom: 16 },
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
  inputComErro: { borderColor: "#FF6B6B" },
  textArea: { minHeight: 80, textAlignVertical: "top" },
  erro: { color: "#FF6B6B", marginTop: 8, fontSize: 13 },
  botao: {
    marginTop: 28,
    backgroundColor: "#3D8BFD",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
  },
  botaoDesabilitado: { backgroundColor: "#354456" },
  botaoTexto: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  botaoSecundario: {
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderWidth: 1,
    borderColor: "#3D8BFD",
  },
  botaoSecundarioTexto: { color: "#3D8BFD", fontSize: 15, fontWeight: "600" },
});
