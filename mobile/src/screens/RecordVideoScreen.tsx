import { useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "@/navigation/RootNavigator";
import type { SelectedVideo } from "@/types/capture";
import { MAX_DURATION_S, MIN_DURATION_S } from "@/utils/video";

type Props = NativeStackScreenProps<RootStackParamList, "RecordVideo">;

export function RecordVideoScreen({ navigation, route }: Props) {
  const { form } = route.params;
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [gravando, setGravando] = useState(false);

  async function buildSelectedVideo(uri: string): Promise<SelectedVideo | null> {
    const info = await FileSystem.getInfoAsync(uri, { size: true });
    if (!info.exists) {
      Alert.alert("Erro", "Não foi possível ler o arquivo de vídeo selecionado.");
      return null;
    }

    // expo-camera/image-picker não retornam duração diretamente aqui;
    // a duração exata é confirmada na tela de Prévia via expo-av.
    return {
      uri,
      durationMs: 0,
      sizeBytes: info.size ?? 0,
      fileName: uri.split("/").pop() ?? "video.mp4",
      mimeType: "video/mp4",
    };
  }

  async function gravarVideo() {
    if (!permission?.granted) {
      const resposta = await requestPermission();
      if (!resposta.granted) {
        Alert.alert("Permissão necessária", "Autorize o uso da câmera para gravar o vídeo.");
        return;
      }
    }
    if (!cameraRef.current) return;

    try {
      setGravando(true);
      const video = await cameraRef.current.recordAsync({
        maxDuration: MAX_DURATION_S,
      });
      setGravando(false);
      if (!video?.uri) return;

      const selected = await buildSelectedVideo(video.uri);
      if (selected) {
        navigation.navigate("Preview", { form, video: selected });
      }
    } catch (error) {
      setGravando(false);
      Alert.alert("Erro ao gravar", "Não foi possível concluir a gravação. Tente novamente.");
    }
  }

  function pararGravacao() {
    cameraRef.current?.stopRecording();
  }

  async function selecionarDaGaleria() {
    const resultado = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      quality: 1,
      videoMaxDuration: MAX_DURATION_S + 5, // margem; validação final é na Prévia
    });

    if (resultado.canceled || !resultado.assets?.[0]) return;

    const asset = resultado.assets[0];
    const selected = await buildSelectedVideo(asset.uri);
    if (selected) {
      navigation.navigate("Preview", { form, video: selected });
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.instrucao}>
        Grave um vídeo de {MIN_DURATION_S} a {MAX_DURATION_S} segundos mostrando o cocho, ou
        selecione um vídeo já gravado.
      </Text>

      {permission?.granted ? (
        <View style={styles.cameraWrapper}>
          <CameraView ref={cameraRef} style={styles.camera} mode="video" facing="back" />
        </View>
      ) : (
        <View style={[styles.cameraWrapper, styles.cameraPlaceholder]}>
          <Text style={styles.placeholderTexto}>
            Toque em "Gravar vídeo" para autorizar o uso da câmera.
          </Text>
        </View>
      )}

      <View style={styles.botoesLinha}>
        <Pressable
          style={[styles.botao, gravando && styles.botaoAtivo]}
          onPress={gravando ? pararGravacao : gravarVideo}
        >
          <Text style={styles.botaoTexto}>{gravando ? "Parar gravação" : "Gravar vídeo"}</Text>
        </Pressable>
      </View>

      <Pressable style={styles.botaoSecundario} onPress={selecionarDaGaleria}>
        <Text style={styles.botaoSecundarioTexto}>Selecionar vídeo da galeria</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 16 },
  instrucao: { color: "#D0D3D8", fontSize: 14 },
  cameraWrapper: {
    flex: 1,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  camera: { flex: 1 },
  cameraPlaceholder: { alignItems: "center", justifyContent: "center", padding: 20 },
  placeholderTexto: { color: "#8A8F98", textAlign: "center" },
  botoesLinha: { flexDirection: "row", gap: 12 },
  botao: {
    flex: 1,
    backgroundColor: "#3D8BFD",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
  },
  botaoAtivo: { backgroundColor: "#E14444" },
  botaoTexto: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  botaoSecundario: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#3D8BFD",
  },
  botaoSecundarioTexto: { color: "#3D8BFD", fontSize: 15, fontWeight: "600" },
});
