import { useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, Vibration, View, useWindowDimensions } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library/legacy";
import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as ImagePicker from "expo-image-picker";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import type { SelectedVideo } from "@/types/capture";
import { MAX_DURATION_S, MIN_DURATION_S, RECORDING_DURATION_S } from "@/utils/video";

type Props = NativeStackScreenProps<RootStackParamList, "RecordVideo">;
type Modo = "escolha" | "camera";

// Guia visual de enquadramento (ver comentário maior mais abaixo, onde a
// proporção é calculada) — tamanho dos "cantos" do contorno, não do
// contorno em si.
const TAMANHO_CANTO_GUIA = 28;
const ESPESSURA_CANTO_GUIA = 4;

export function RecordVideoScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { width: larguraTela, height: alturaTela } = useWindowDimensions();
  const { form } = route.params;
  const [abrindoCamera, setAbrindoCamera] = useState(false);
  const [modo, setModo] = useState<Modo>("escolha");
  const [gravando, setGravando] = useState(false);

  const cameraRef = useRef<CameraView>(null);
  // `true` só quando "Cancelar" foi tocado durante a gravação — diferencia um
  // corte deliberado (descarta e não vibra) do corte automático nos 8.5s
  // (segue pra Prévia e vibra), já que os dois chegam pelo mesmo
  // `stopRecording()`/resolução da Promise de `recordAsync`.
  const canceladoRef = useRef(false);
  const timerCorteRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [permissaoCamera, solicitarPermissaoCamera] = useCameraPermissions();
  const [permissaoMicrofone, solicitarPermissaoMicrofone] = useMicrophonePermissions();

  /**
   * Mesma lógica de `obterHorarioReal` de antes, mas só com o fallback de
   * data de modificação do arquivo: vídeo gravado agora pela câmera do app
   * nunca tem `assetId` de `expo-image-picker` (não veio de um seletor), só
   * o vídeo escolhido da galeria tem.
   */
  async function horarioPorDataDoArquivo(uri: string): Promise<number | undefined> {
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists && info.modificationTime) return info.modificationTime * 1000;
    } catch {
      // sem essa fonte: undefined mesmo
    }
    return undefined;
  }

  async function obterHorarioRealGaleria(asset: ImagePicker.ImagePickerAsset): Promise<number | undefined> {
    if (asset.assetId) {
      try {
        const permissao = await MediaLibrary.requestPermissionsAsync();
        if (permissao.granted) {
          const info = await MediaLibrary.getAssetInfoAsync(asset.assetId);
          if (info.creationTime) return info.creationTime;
        }
      } catch {
        // segue pro fallback abaixo
      }
    }
    return horarioPorDataDoArquivo(asset.uri);
  }

  async function buildSelectedVideo(
    uri: string,
    recordedAt: number | undefined,
    origem: "camera" | "galeria"
  ): Promise<SelectedVideo | null> {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) {
      Alert.alert("Erro", "Não foi possível ler o arquivo de vídeo selecionado.");
      return null;
    }

    return {
      uri,
      // Duração exata é sempre confirmada na Prévia via expo-video (ver
      // `PreviewScreen.tsx`); aqui é só um valor inicial pra exibição
      // enquanto isso não carrega. Pra vídeo de câmera, `RECORDING_DURATION_S`
      // já é uma estimativa bem próxima da real, diferente da galeria (0,
      // porque ali a duração é livre e não dá pra estimar).
      durationMs: origem === "camera" ? RECORDING_DURATION_S * 1000 : 0,
      sizeBytes: info.size ?? 0,
      fileName: uri.split("/").pop() ?? "video.mp4",
      mimeType: "video/mp4",
      recordedAt,
      origem,
    };
  }

  async function abrirCamera() {
    setAbrindoCamera(true);
    if (!permissaoCamera?.granted) {
      const resultado = await solicitarPermissaoCamera();
      if (!resultado.granted) {
        setAbrindoCamera(false);
        Alert.alert("Permissão necessária", "Autorize o uso da câmera para gravar o vídeo.");
        return;
      }
    }
    if (!permissaoMicrofone?.granted) {
      const resultado = await solicitarPermissaoMicrofone();
      if (!resultado.granted) {
        setAbrindoCamera(false);
        Alert.alert("Permissão necessária", "Autorize o uso do microfone para gravar o vídeo.");
        return;
      }
    }
    setAbrindoCamera(false);
    setModo("camera");
  }

  /**
   * Inicia a gravação e a corta sozinha em `RECORDING_DURATION_S`, sem
   * depender de a pessoa apertar nada pra parar. O corte de verdade é feito
   * por um `setTimeout` próprio, não pelo `maxDuration` do `recordAsync`:
   * assim garantimos o mesmo comportamento em qualquer aparelho, sem
   * depender de arredondamento da API nativa pra um valor com casa decimal.
   * `maxDuration` continua presente só como rede de segurança, um pouco
   * acima do alvo, caso este timer falhe por algum motivo.
   */
  async function iniciarGravacao() {
    if (!cameraRef.current || gravando) return;
    canceladoRef.current = false;
    setGravando(true);

    timerCorteRef.current = setTimeout(() => {
      cameraRef.current?.stopRecording();
    }, RECORDING_DURATION_S * 1000);

    try {
      const resultado = await cameraRef.current.recordAsync({
        maxDuration: RECORDING_DURATION_S + 1,
      });
      if (timerCorteRef.current) clearTimeout(timerCorteRef.current);
      setGravando(false);

      if (canceladoRef.current) {
        // Descarte deliberado (botão "Cancelar") — some com o arquivo
        // parcial e volta pra tela de escolha, sem vibrar nem seguir.
        if (resultado?.uri) {
          FileSystem.deleteAsync(resultado.uri, { idempotent: true }).catch(() => undefined);
        }
        setModo("escolha");
        return;
      }

      if (!resultado?.uri) {
        Alert.alert("Erro ao gravar", "Não foi possível concluir a gravação. Tente novamente.");
        setModo("escolha");
        return;
      }

      // Sinaliza pra quem gravou que já pode soltar o celular — ela não
      // precisa contar o tempo nem ficar de olho na tela.
      Vibration.vibrate();

      const recordedAt = (await horarioPorDataDoArquivo(resultado.uri)) ?? Date.now();
      const selected = await buildSelectedVideo(resultado.uri, recordedAt, "camera");
      setModo("escolha");
      if (selected) {
        navigation.navigate("Preview", { form, video: selected });
      }
    } catch (error) {
      if (timerCorteRef.current) clearTimeout(timerCorteRef.current);
      setGravando(false);
      setModo("escolha");
      Alert.alert("Erro ao gravar", "Não foi possível concluir a gravação. Tente novamente.");
    }
  }

  function cancelarGravacao() {
    canceladoRef.current = true;
    cameraRef.current?.stopRecording();
  }

  function sairDaCamera() {
    if (gravando) return; // usa "Cancelar" durante a gravação, não este botão
    setModo("escolha");
  }

  async function selecionarDaGaleria() {
    const resultado = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
      quality: 1,
      videoMaxDuration: MAX_DURATION_S + 5, // margem; validação final é na Prévia
      // Mesmo tratamento de sempre: recomprime o vídeo escolhido para
      // 720p H.264 antes de devolver ao app, mesmo que o arquivo original
      // salvo no aparelho esteja em resolução nativa da câmera (4K, etc.).
      videoExportPreset: ImagePicker.VideoExportPreset.H264_1280x720,
    });

    if (resultado.canceled || !resultado.assets?.[0]) return;

    const asset = resultado.assets[0];
    const recordedAt = await obterHorarioRealGaleria(asset);
    const selected = await buildSelectedVideo(asset.uri, recordedAt, "galeria");
    if (selected) {
      navigation.navigate("Preview", { form, video: selected });
    }
  }

  /**
   * Guia visual de enquadramento: um contorno na tela pra ajudar a manter
   * distância e ângulo da câmera parecidos entre pessoas e entre anos. A
   * proporção do contorno vem do comprimento/largura já cadastrados pra
   * este cocho (`form.cocho`, o mesmo snapshot que já viaja desde o
   * cadastro em `CochosScreen.tsx`), então ele se adapta sozinho quando um
   * cocho de outro formato for cadastrado, sem precisar redesenhar nada
   * aqui — inclusive o cocho fisicamente diferente do experimento que
   * começa em 2027 (ver `decisoes-anotacao.md`).
   *
   * Duas limitações conhecidas, aceitas por ora: (1) isso dá a FORMA certa
   * do contorno, não o tamanho físico certo — não sabemos o campo de visão
   * da câmera de cada aparelho, então não dá pra saber a que distância
   * real o contorno corresponde; a pessoa ainda se posiciona até o cocho
   * visível bater no contorno, não até uma distância em metros. (2)
   * comprimento/largura são medidos de cima, mas o vídeo é gravado de um
   * ângulo, então a proporção que aparece na tela pode não bater
   * exatamente com a proporção física — tratar como ponto de partida
   * razoável, ajustado depois com um teste real, não como matemática
   * exata.
   */
  const proporcaoCocho = form.cocho.larguraCm > 0 ? form.cocho.comprimentoCm / form.cocho.larguraCm : 3;
  const larguraMaximaGuia = larguraTela * 0.82;
  const alturaMaximaGuia = alturaTela * 0.5;
  let larguraGuia = larguraMaximaGuia;
  let alturaGuia = larguraGuia / proporcaoCocho;
  if (alturaGuia > alturaMaximaGuia) {
    alturaGuia = alturaMaximaGuia;
    larguraGuia = alturaGuia * proporcaoCocho;
  }

  if (modo === "camera") {
    return (
      <View style={styles.telaCamera}>
        <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} mode="video" facing="back" videoQuality="720p" />

        <View style={styles.guiaContainer} pointerEvents="none">
          <View style={{ width: larguraGuia, height: alturaGuia }}>
            <View style={[styles.guiaCantoH, styles.guiaCantoTopoEsquerdo]} />
            <View style={[styles.guiaCantoV, styles.guiaCantoTopoEsquerdo]} />
            <View style={[styles.guiaCantoH, styles.guiaCantoTopoDireito]} />
            <View style={[styles.guiaCantoV, styles.guiaCantoTopoDireito]} />
            <View style={[styles.guiaCantoH, styles.guiaCantoBaseEsquerdo]} />
            <View style={[styles.guiaCantoV, styles.guiaCantoBaseEsquerdo]} />
            <View style={[styles.guiaCantoH, styles.guiaCantoBaseDireito]} />
            <View style={[styles.guiaCantoV, styles.guiaCantoBaseDireito]} />
          </View>
        </View>

        <View style={[styles.overlayTopo, { top: insets.top + 12 }]} pointerEvents="box-none">
          <Text style={styles.avisoCamera}>
            {gravando
              ? "Gravando... o vídeo para sozinho, é só manter o cocho no quadro."
              : "Alinhe o cocho dentro da marcação e aperte para gravar."}
          </Text>
        </View>

        <View style={[styles.overlayBase, { paddingBottom: 24 + insets.bottom }]} pointerEvents="box-none">
          {gravando ? (
            <Pressable style={styles.botaoCancelar} onPress={cancelarGravacao}>
              <Text style={styles.botaoCancelarTexto}>Cancelar</Text>
            </Pressable>
          ) : (
            <View style={styles.linhaBotoesCamera}>
              <Pressable style={styles.botaoVoltarCamera} onPress={sairDaCamera}>
                <Text style={styles.botaoVoltarCameraTexto}>Voltar</Text>
              </Pressable>
              <Pressable style={styles.botaoGravar} onPress={iniciarGravacao}>
                <View style={styles.botaoGravarMiolo} />
              </Pressable>
              <View style={styles.espacador} />
            </View>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingBottom: 20 + insets.bottom }]}>
      <Text style={styles.instrucao}>
        Aperte "Gravar vídeo" e mantenha o cocho no quadro: a gravação para sozinha depois de
        alguns segundos, sem precisar contar o tempo. Ou selecione um vídeo já gravado, de {MIN_DURATION_S} a{" "}
        {MAX_DURATION_S} segundos.
      </Text>

      <View style={styles.botoesCentro}>
        <Pressable
          style={[styles.botao, abrindoCamera && styles.botaoDesabilitado]}
          onPress={abrirCamera}
          disabled={abrindoCamera}
        >
          <Text style={styles.botaoTexto}>{abrindoCamera ? "Abrindo câmera..." : "Gravar vídeo"}</Text>
        </Pressable>

        <Pressable style={styles.botaoSecundario} onPress={selecionarDaGaleria}>
          <Text style={styles.botaoSecundarioTexto}>Selecionar vídeo da galeria</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 16 },
  instrucao: { color: "#D0D3D8", fontSize: 14 },
  botoesCentro: { flex: 1, justifyContent: "center", gap: 12 },
  botao: {
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
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#3D8BFD",
  },
  botaoSecundarioTexto: { color: "#3D8BFD", fontSize: 15, fontWeight: "600" },

  telaCamera: { flex: 1, backgroundColor: "#000" },
  guiaContainer: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  guiaCantoH: {
    position: "absolute",
    width: TAMANHO_CANTO_GUIA,
    height: ESPESSURA_CANTO_GUIA,
    backgroundColor: "rgba(255,255,255,0.9)",
    borderRadius: 2,
  },
  guiaCantoV: {
    position: "absolute",
    width: ESPESSURA_CANTO_GUIA,
    height: TAMANHO_CANTO_GUIA,
    backgroundColor: "rgba(255,255,255,0.9)",
    borderRadius: 2,
  },
  guiaCantoTopoEsquerdo: { top: 0, left: 0 },
  guiaCantoTopoDireito: { top: 0, right: 0 },
  guiaCantoBaseEsquerdo: { bottom: 0, left: 0 },
  guiaCantoBaseDireito: { bottom: 0, right: 0 },
  overlayTopo: { position: "absolute", left: 16, right: 16, alignItems: "center" },
  avisoCamera: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
    backgroundColor: "rgba(16,24,32,0.7)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  overlayBase: { position: "absolute", left: 0, right: 0, bottom: 0, alignItems: "center" },
  linhaBotoesCamera: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    paddingHorizontal: 32,
  },
  espacador: { width: 72 },
  botaoVoltarCamera: {
    width: 72,
    paddingVertical: 10,
    alignItems: "center",
    borderRadius: 10,
    backgroundColor: "rgba(16,24,32,0.7)",
  },
  botaoVoltarCameraTexto: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
  botaoGravar: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  botaoGravarMiolo: { width: 60, height: 60, borderRadius: 30, backgroundColor: "#FF4D4D" },
  botaoCancelar: {
    backgroundColor: "rgba(255,77,77,0.9)",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },
  botaoCancelarTexto: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
});
