import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
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
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "@/navigation/RootNavigator";
import type { CaptureFormData } from "@/types/capture";
import {
  formatDuration,
  formatFileSize,
  isDurationValid,
  isRecordingDurationValid,
  MAX_DURATION_S,
  MIN_DURATION_S,
  RECORDING_DURATION_S,
} from "@/utils/video";
import { generateCaptureId } from "@/utils/uuid";
import { parsePesoInput } from "@/utils/peso";
import { enqueueCapture } from "@/services/offlineQueue";
import { registrarNoHistorico } from "@/services/historicoEnvios";
import { gerarMiniatura } from "@/services/thumbnails";
import { obterNomeOperador } from "@/services/operador";

type Props = NativeStackScreenProps<RootStackParamList, "Preview">;
type CampoRevisao = "peso" | "observacoes";

/**
 * Linha compacta de revisão: mostra o valor com um link "editar" sublinhado
 * na outra ponta. Ao tocar, o valor dá lugar ao campo de edição (`children`)
 * até a pessoa tocar em "salvar", quando volta a mostrar só o texto — sem
 * deixar a tela cheia de caixa de input o tempo todo.
 */
function LinhaRevisao({
  label,
  editando,
  valorExibicao,
  temValor,
  onIniciarEdicao,
  onSalvar,
  children,
}: {
  label: string;
  editando: boolean;
  valorExibicao: string;
  temValor: boolean;
  onIniciarEdicao: () => void;
  onSalvar: () => void;
  children: ReactNode;
}) {
  return (
    <View style={styles.campoRevisao}>
      <View style={styles.infoLinha}>
        <Text style={styles.infoLabel}>{label}</Text>
        <View style={styles.valorEEditar}>
          {!editando && (
            <Text style={[styles.infoValor, !temValor && styles.infoValorVazio]} numberOfLines={1}>
              {valorExibicao}
            </Text>
          )}
          <Pressable onPress={editando ? onSalvar : onIniciarEdicao} hitSlop={8}>
            <Text style={styles.linkEditar}>{editando ? "salvar" : "editar"}</Text>
          </Pressable>
        </View>
      </View>
      {editando && <View style={styles.editorWrap}>{children}</View>}
    </View>
  );
}

export function PreviewScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { form, video } = route.params;
  const [durationMs, setDurationMs] = useState(video.durationMs);
  const [duracaoCarregada, setDuracaoCarregada] = useState(false);
  const [salvando, setSalvando] = useState(false);

  // Os dados vêm preenchidos do formulário anterior, mas continuam editáveis
  // aqui: a pessoa pode revisar e corrigir sem precisar voltar pra tela de
  // formulário (o que, de qualquer forma, também exigiria regravar o vídeo).
  const [pesoKg, setPesoKg] = useState(form.pesoKg);
  const [observacoes, setObservacoes] = useState(form.observacoes ?? "");
  const [erroPeso, setErroPeso] = useState<string | null>(null);

  // Só um campo por vez fica em modo de edição, pra manter a tela compacta.
  const [campoEditando, setCampoEditando] = useState<CampoRevisao | null>(null);

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

  // Item de fila salvo por uma versão anterior do app não tem `origem` —
  // trata como "galeria", que era o único comportamento antes dela existir.
  const origemVideo = video.origem ?? "galeria";
  const duracaoValida =
    duracaoCarregada &&
    (origemVideo === "camera" ? isRecordingDurationValid(durationMs) : isDurationValid(durationMs));

  function salvarCampo(campo: CampoRevisao) {
    if (campo === "peso") {
      if (parsePesoInput(pesoKg) === null) {
        setErroPeso("Informe o peso real em kg (ex.: 12.5).");
        return; // mantém o campo aberto pra pessoa corrigir
      }
      setErroPeso(null);
    }
    if (campo === "observacoes") setObservacoes((v) => v.trim());
    setCampoEditando(null);
  }

  async function confirmarEEnviar() {
    if (parsePesoInput(pesoKg) === null) {
      setCampoEditando("peso");
      setErroPeso("Informe o peso real em kg (ex.: 12.5).");
      return;
    }
    setErroPeso(null);

    if (!duracaoCarregada) {
      Alert.alert("Aguarde", "Carregando informações do vídeo...");
      return;
    }
    if (!duracaoValida) {
      const mensagemFaixa =
        origemVideo === "camera"
          ? `O vídeo gravado precisa ter cerca de ${RECORDING_DURATION_S}s.`
          : `O vídeo precisa ter entre ${MIN_DURATION_S} e ${MAX_DURATION_S} segundos.`;
      Alert.alert(
        "Duração inválida",
        `${mensagemFaixa} Duração atual: ${formatDuration(durationMs)}. Grave ou selecione novamente.`
      );
      return;
    }

    // Nome de quem está gravando, configurado uma vez no Lobby — não é um
    // campo editável aqui na Prévia, é uma configuração do aparelho (ver
    // `services/operador.ts`).
    const operador = await obterNomeOperador();
    const formAtualizado: CaptureFormData = {
      pesoKg,
      // Não editáveis aqui: cocho e tipo de alimento já foram selecionados
      // antes de gravar (ver `CochosScreen.tsx` -> `TiposAlimentoScreen.tsx`
      // -> `CaptureFormScreen.tsx`) e mudar qualquer um dos dois depois
      // exigiria regravar o vídeo de qualquer forma.
      tipoAlimento: form.tipoAlimento,
      cocho: form.cocho,
      observacoes: observacoes.trim() || undefined,
      operador,
    };

    // A partir daqui a captura já está "segura": ela é copiada para um
    // armazenamento durável do app e registrada na fila local ANTES de
    // qualquer tentativa de envio. Se não houver wifi agora, o app tenta de
    // novo sozinho mais tarde — ver src/services/syncEngine.ts.
    setSalvando(true);
    const captureId = generateCaptureId();
    try {
      const itemFila = await enqueueCapture({
        captureId,
        video: { ...video, durationMs },
        form: formAtualizado,
      });
      // Gerada a partir da cópia durável do vídeo (não do arquivo original,
      // que pode sumir do cache do seletor depois) — guardada numa pasta
      // própria que sobrevive mesmo depois do vídeo ser apagado ao enviar
      // com sucesso. Ver `services/thumbnails.ts`.
      const thumbnailUri = await gerarMiniatura(captureId, itemFila.videoUri);
      // Histórico é só pra exibição — nunca deve impedir o envio de verdade,
      // então falha aqui é ignorada (a captura já está segura na fila de
      // qualquer forma). Aguarda em vez de disparar e esquecer pra reduzir a
      // janela de captura "órfã" (na fila mas sem registro no Histórico);
      // `reconciliarComFila` cobre o resto dos casos, inclusive esse aqui se
      // ele mesmo falhar.
      await registrarNoHistorico({ captureId, form: formAtualizado, thumbnailUri }).catch(() => undefined);
    } catch (error) {
      setSalvando(false);
      Alert.alert(
        "Erro ao salvar",
        "Não foi possível salvar o vídeo para envio. Verifique o espaço livre no aparelho e tente novamente."
      );
      return;
    }

    navigation.navigate("UploadStatus", { captureId });
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.container}>
        <View style={styles.playerWrapper}>
          <VideoView style={styles.player} player={player} nativeControls contentFit="contain" />
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollConteudo}
          keyboardShouldPersistTaps="handled"
        >
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

            <LinhaRevisao
              label="Peso informado"
              editando={campoEditando === "peso"}
              valorExibicao={`${pesoKg} kg`}
              temValor
              onIniciarEdicao={() => setCampoEditando("peso")}
              onSalvar={() => salvarCampo("peso")}
            >
              <TextInput
                style={styles.input}
                value={pesoKg}
                onChangeText={setPesoKg}
                placeholder="Ex.: 12.5"
                placeholderTextColor="#8A8F98"
                keyboardType="decimal-pad"
                autoFocus
              />
            </LinhaRevisao>
            {erroPeso && <Text style={styles.erro}>{erroPeso}</Text>}

            <View style={styles.infoLinha}>
              <Text style={styles.infoLabel}>Tipo de alimento</Text>
              <Text style={styles.infoValor} numberOfLines={1}>
                {form.tipoAlimento.nome}
              </Text>
            </View>

            <View style={styles.infoLinha}>
              <Text style={styles.infoLabel}>Cocho</Text>
              <Text style={styles.infoValor} numberOfLines={1}>
                {form.cocho.nome}
              </Text>
            </View>
          </View>

          <View style={styles.observacoesBox}>
            <View style={styles.infoLinha}>
              <Text style={styles.infoLabel}>Observações</Text>
              <Pressable
                onPress={() =>
                  campoEditando === "observacoes" ? salvarCampo("observacoes") : setCampoEditando("observacoes")
                }
                hitSlop={8}
              >
                <Text style={styles.linkEditar}>{campoEditando === "observacoes" ? "salvar" : "editar"}</Text>
              </Pressable>
            </View>
            {campoEditando === "observacoes" ? (
              <TextInput
                style={[styles.input, styles.textArea]}
                value={observacoes}
                onChangeText={setObservacoes}
                placeholder="Alguma observação sobre esta captura?"
                placeholderTextColor="#8A8F98"
                multiline
                numberOfLines={3}
                autoFocus
              />
            ) : (
              <Text style={[styles.observacoesTexto, !observacoes && styles.infoValorVazio]}>
                {observacoes || "Não informado"}
              </Text>
            )}
          </View>

          {duracaoCarregada && !duracaoValida && (
            <Text style={styles.aviso}>
              {origemVideo === "camera"
                ? `Duração fora do esperado para vídeo gravado (~${RECORDING_DURATION_S}s). Grave novamente.`
                : `Duração fora do intervalo de ${MIN_DURATION_S}–${MAX_DURATION_S}s. Grave novamente.`}
            </Text>
          )}
        </ScrollView>

        <View style={[styles.botoesLinha, { paddingBottom: insets.bottom }]}>
          <Pressable style={styles.botaoSecundario} onPress={() => navigation.goBack()} disabled={salvando}>
            <Text style={styles.botaoSecundarioTexto}>Regravar</Text>
          </Pressable>
          <Pressable
            style={[styles.botao, (!duracaoValida || salvando) && styles.botaoDesabilitado]}
            onPress={confirmarEEnviar}
            disabled={!duracaoValida || salvando}
          >
            <Text style={styles.botaoTexto}>{salvando ? "Salvando..." : "Enviar captura"}</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, padding: 20, gap: 16 },
  // Altura máxima em vez de flex:1 puro: dá espaço pros campos abaixo sem
  // que o vídeo suma da tela quando o teclado abre pra editar algo.
  playerWrapper: { flex: 1, maxHeight: "38%", borderRadius: 14, overflow: "hidden", backgroundColor: "#000" },
  player: { flex: 1 },
  scrollConteudo: { gap: 16, paddingBottom: 4 },
  infoBox: { backgroundColor: "#1B2530", borderRadius: 12, padding: 16, gap: 10 },
  infoLinha: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  infoLabel: { color: "#B5B9C0", fontSize: 14 },
  infoValor: { color: "#F5F5F5", fontSize: 14, fontWeight: "600", flexShrink: 1 },
  infoValorVazio: { color: "#8A8F98", fontWeight: "400", fontStyle: "italic" },
  infoInvalida: { color: "#FF6B6B" },
  campoRevisao: { gap: 8 },
  valorEEditar: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1, justifyContent: "flex-end" },
  linkEditar: { color: "#3D8BFD", fontSize: 13, fontWeight: "600", textDecorationLine: "underline" },
  editorWrap: { marginTop: -2 },
  observacoesBox: { backgroundColor: "#1B2530", borderRadius: 12, padding: 16, gap: 8 },
  observacoesTexto: { color: "#F5F5F5", fontSize: 14, lineHeight: 20 },
  aviso: { color: "#FFB020", fontSize: 13 },
  input: {
    backgroundColor: "#101820",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: "#F5F5F5",
    fontSize: 15,
    borderWidth: 1,
    borderColor: "#2A3542",
  },
  textArea: { minHeight: 80, textAlignVertical: "top" },
  erro: { color: "#FF6B6B", marginTop: -4, fontSize: 13 },
  botoesLinha: { flexDirection: "row", gap: 12, paddingTop: 4 },
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
