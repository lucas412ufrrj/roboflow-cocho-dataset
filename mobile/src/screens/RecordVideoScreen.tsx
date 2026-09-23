import { useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, Vibration, View } from "react-native";
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

export function RecordVideoScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
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

  function formatarMB(bytes: number | null | undefined): string {
    if (!bytes && bytes !== 0) return "?";
    return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  }

  /** Espaço livre no aparelho, em bytes. `null` quando não dá pra descobrir
   * (a função não existe na versão instalada da biblioteca de arquivos, ou o
   * sistema não respondeu) — nesse caso seguimos em frente sem a checagem
   * prévia, em vez de bloquear por falta de uma informação auxiliar. */
  async function espacoLivreBytes(): Promise<number | null> {
    try {
      const fn = (FileSystem as unknown as { getFreeDiskStorageAsync?: () => Promise<number> })
        .getFreeDiskStorageAsync;
      if (typeof fn !== "function") return null;
      return await fn();
    } catch {
      return null;
    }
  }

  type MotivoFalha = "espaco" | "nuvem" | "ilegivel";

  /**
   * Classifica a falha da cópia para conseguir dizer à pessoa o que houve, em
   * vez do antigo "não foi possível ler" genérico, que não distinguia celular
   * cheio de vídeo que mora na nuvem. A classificação é por palavra-chave na
   * mensagem do sistema, então é heurística: o texto cru vai junto no aviso e
   * no log, e qualquer coisa não reconhecida cai em "ilegivel" mostrando esse
   * texto, em vez de ser engolida.
   */
  function classificarFalhaDeCopia(detalhe: string): MotivoFalha {
    const t = detalhe.toLowerCase();
    if (t.includes("enospc") || t.includes("no space") || t.includes("espaço") || t.includes("space left")) {
      return "espaco";
    }
    if (
      t.includes("network") ||
      t.includes("offline") ||
      t.includes("download") ||
      t.includes("unavailable") ||
      t.includes("timed out") ||
      t.includes("timeout")
    ) {
      return "nuvem";
    }
    return "ilegivel";
  }

  function avisarFalhaDaGaleria(
    motivo: MotivoFalha,
    dados: { detalhe: string; tamanhoVideo?: number | null; livre?: number | null; uri: string }
  ) {
    // Prefixo do endereço (file, content, ph...) diz muito sobre a origem do
    // problema e não expõe nada sensível — é o que mais ajuda quando alguém
    // da equipe manda um print do aviso.
    const esquema = dados.uri.split(":")[0] || "?";
    const rodape = `Detalhe: ${dados.detalhe.slice(0, 160)}\nVídeo: ${formatarMB(
      dados.tamanhoVideo
    )} · Livre: ${formatarMB(dados.livre)} · Origem: ${esquema}`;

    const textos: Record<MotivoFalha, string> = {
      espaco:
        "Seu celular está sem espaço para preparar o vídeo.\n\n" +
        "O app guarda uma cópia de cada captura que ainda não foi enviada. Abra o Histórico: " +
        "enviar (ou cancelar) as capturas pendentes libera esse espaço.",
      nuvem:
        "Esse vídeo não está baixado no aparelho, parece estar salvo só na nuvem.\n\n" +
        "Abra ele na galeria até carregar por completo, ou conecte numa rede melhor, e tente de novo.",
      ilegivel:
        "Não foi possível preparar o vídeo selecionado.\n\n" +
        "Tente escolher de novo. Se continuar, grave pela câmera do próprio app, " +
        "que não depende da galeria.",
    };

    console.log(
      `[RecordVideo] falha ao preparar vídeo da galeria: motivo=${motivo} esquema=${esquema} ` +
        `tamanho=${dados.tamanhoVideo ?? "?"} livre=${dados.livre ?? "?"} detalhe=${dados.detalhe}`
    );
    Alert.alert("Não deu para usar esse vídeo", `${textos[motivo]}\n\n${rodape}`);
  }

  /**
   * Prepara o vídeo escolhido no seletor: copia para dentro do espaço do app
   * e devolve o caminho da cópia, ou `null` (já avisando a pessoa) quando não
   * dá.
   *
   * A cópia existe porque o endereço que o seletor devolve nem sempre é um
   * arquivo comum: no Android costuma vir como `content://...`, um endereço
   * do provedor de conteúdo do sistema, que `getInfoAsync`/`readAsStringAsync`
   * não conseguem inspecionar nem ler por posição. De quebra, protege de o
   * Android limpar o cache do seletor entre a escolha e o envio (que pode
   * demorar bastante, se a pessoa estiver sem sinal no curral).
   *
   * Quando a cópia falha, NÃO seguimos com o endereço original só porque o
   * seletor informou um tamanho: um `content://` que não pôde ser copiado
   * também não vai poder ser lido em blocos na hora de enviar, e o envio
   * quebraria bem mais tarde, longe da causa. Só reaproveitamos o original
   * quando ele é, comprovadamente, um arquivo legível.
   */
  async function prepararVideoDaGaleria(
    asset: ImagePicker.ImagePickerAsset
  ): Promise<string | null> {
    const livre = await espacoLivreBytes();
    const tamanho = asset.fileSize ?? null;

    // Checagem prévia: a cópia precisa de espaço livre do tamanho do vídeo.
    // A margem de 10% cobre o que o sistema reserva por fora do arquivo.
    if (livre !== null && tamanho !== null && livre < tamanho * 1.1) {
      avisarFalhaDaGaleria("espaco", {
        detalhe: "espaço livre insuficiente para copiar o vídeo (checado antes de tentar)",
        tamanhoVideo: tamanho,
        livre,
        uri: asset.uri,
      });
      return null;
    }

    const nome = (asset.fileName ?? asset.uri.split("/").pop() ?? "video.mp4").replace(/[^\w.-]/g, "_");
    const destino = `${FileSystem.cacheDirectory}galeria-${Date.now()}-${nome}`;
    try {
      await FileSystem.copyAsync({ from: asset.uri, to: destino });
      return destino;
    } catch (erro) {
      const detalhe = erro instanceof Error ? erro.message : String(erro);

      // A cópia falhou: o endereço original só serve se for mesmo um arquivo
      // legível (ex.: o seletor já tinha deixado uma cópia no cache dele).
      const info = await FileSystem.getInfoAsync(asset.uri).catch(() => null);
      if (info?.exists && (info.size ?? 0) > 0) {
        console.log(
          `[RecordVideo] cópia falhou (${detalhe}), mas o endereço original é legível — seguindo com ele.`
        );
        return asset.uri;
      }

      avisarFalhaDaGaleria(classificarFalhaDeCopia(detalhe), {
        detalhe,
        tamanhoVideo: tamanho,
        livre,
        uri: asset.uri,
      });
      return null;
    }
  }

  async function buildSelectedVideo(
    uri: string,
    recordedAt: number | undefined,
    origem: "camera" | "galeria",
    doSeletor?: { sizeBytes?: number | null; fileName?: string | null; durationMs?: number | null }
  ): Promise<SelectedVideo | null> {
    const info = await FileSystem.getInfoAsync(uri).catch(() => null);
    // O tamanho do seletor entra só como complemento, quando o arquivo existe
    // mas o sistema não informou o tamanho. Ele NÃO serve pra decidir que um
    // endereço ilegível está bom: essa decisão é do `info.exists` (ver o
    // comentário em `prepararVideoDaGaleria`).
    const sizeBytes = (info?.exists ? info.size : undefined) ?? (info?.exists ? doSeletor?.sizeBytes : 0) ?? 0;
    if (!info?.exists || !sizeBytes) {
      console.log(
        `[RecordVideo] arquivo final inutilizável: origem=${origem} existe=${info?.exists ?? false} ` +
          `tamanho=${sizeBytes} uri=${uri.split(":")[0]}`
      );
      Alert.alert(
        "Não deu para usar esse vídeo",
        "Não foi possível ler o arquivo de vídeo. Tente escolher de novo, ou grave pela câmera do próprio app."
      );
      return null;
    }

    return {
      uri,
      // Duração exata é sempre confirmada na Prévia via expo-video (ver
      // `PreviewScreen.tsx`); aqui é só um valor inicial pra exibição
      // enquanto isso não carrega. Pra vídeo de câmera, `RECORDING_DURATION_S`
      // já é uma estimativa bem próxima da real; pra galeria, usamos a
      // duração que o próprio seletor informou, quando ele informa.
      durationMs: origem === "camera" ? RECORDING_DURATION_S * 1000 : (doSeletor?.durationMs ?? 0),
      sizeBytes,
      fileName: doSeletor?.fileName ?? uri.split("/").pop() ?? "video.mp4",
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
    // O horário real é lido do asset ORIGINAL (é ele que o sistema conhece
    // pela galeria), antes de copiar — a cópia tem data de agora, não a da
    // gravação.
    const recordedAt = await obterHorarioRealGaleria(asset);
    // Trabalha sempre com uma cópia dentro do app (ver
    // `prepararVideoDaGaleria`); quando não dá, a própria função já explica
    // o motivo pra pessoa e devolve `null`.
    const uriLocal = await prepararVideoDaGaleria(asset);
    if (!uriLocal) return;
    const selected = await buildSelectedVideo(uriLocal, recordedAt, "galeria", {
      sizeBytes: asset.fileSize,
      fileName: asset.fileName,
      durationMs: asset.duration,
    });
    if (selected) {
      navigation.navigate("Preview", { form, video: selected });
    }
  }

  if (modo === "camera") {
    return (
      <View style={styles.telaCamera}>
        <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} mode="video" facing="back" videoQuality="720p" />

        <View style={[styles.overlayTopo, { top: insets.top + 12 }]} pointerEvents="box-none">
          <Text style={styles.avisoCamera}>
            {gravando
              ? "Gravando... o vídeo para sozinho, é só manter o cocho no quadro."
              : "Mantenha o cocho inteiro visível na tela e aperte para gravar."}
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
