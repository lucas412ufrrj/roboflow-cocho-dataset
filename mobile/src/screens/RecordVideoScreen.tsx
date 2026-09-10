import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as ImagePicker from "expo-image-picker";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import type { SelectedVideo } from "@/types/capture";
import { MAX_DURATION_S, MIN_DURATION_S } from "@/utils/video";

type Props = NativeStackScreenProps<RootStackParamList, "RecordVideo">;

export function RecordVideoScreen({ navigation, route }: Props) {
  const { form } = route.params;
  const [abrindoCamera, setAbrindoCamera] = useState(false);

  async function buildSelectedVideo(uri: string): Promise<SelectedVideo | null> {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) {
      Alert.alert("Erro", "Não foi possível ler o arquivo de vídeo selecionado.");
      return null;
    }

    // expo-image-picker não retorna duração diretamente aqui;
    // a duração exata é confirmada na tela de Prévia via expo-video.
    return {
      uri,
      durationMs: 0,
      sizeBytes: info.size ?? 0,
      fileName: uri.split("/").pop() ?? "video.mp4",
      mimeType: "video/mp4",
    };
  }

  async function gravarVideo() {
    const permissao = await ImagePicker.requestCameraPermissionsAsync();
    if (!permissao.granted) {
      Alert.alert("Permissão necessária", "Autorize o uso da câmera para gravar o vídeo.");
      return;
    }

    try {
      setAbrindoCamera(true);
      // Usamos a câmera nativa do sistema (UIImagePickerController no iOS,
      // Camera intent no Android) em vez do CameraView customizado: no iOS o
      // `videoBitrate`/`videoQuality` do expo-camera não estava sendo
      // respeitado (vídeos saíam com 60MB+ em resolução nativa da câmera,
      // estourando o timeout de upload do backend). `videoExportPreset`
      // aqui é explícito (720p H.264, resolução fixa) e usa a API nativa e
      // estável de gravação de vídeo do iOS.
      const resultado = await ImagePicker.launchCameraAsync({
        mediaTypes: ["videos"],
        videoMaxDuration: MAX_DURATION_S,
        videoExportPreset: ImagePicker.VideoExportPreset.H264_1280x720,
      });
      setAbrindoCamera(false);

      if (resultado.canceled || !resultado.assets?.[0]) return;

      const selected = await buildSelectedVideo(resultado.assets[0].uri);
      if (selected) {
        navigation.navigate("Preview", { form, video: selected });
      }
    } catch (error) {
      setAbrindoCamera(false);
      Alert.alert("Erro ao gravar", "Não foi possível concluir a gravação. Tente novamente.");
    }
  }

  async function selecionarDaGaleria() {
    const resultado = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
      quality: 1,
      videoMaxDuration: MAX_DURATION_S + 5, // margem; validação final é na Prévia
      // Mesmo tratamento da gravação: recomprime o vídeo escolhido para
      // 720p H.264 antes de devolver ao app, mesmo que o arquivo original
      // salvo no aparelho esteja em resolução nativa da câmera (4K, etc.).
      videoExportPreset: ImagePicker.VideoExportPreset.H264_1280x720,
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

      <View style={styles.botoesCentro}>
        <Pressable
          style={[styles.botao, abrindoCamera && styles.botaoDesabilitado]}
          onPress={gravarVideo}
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
  // Sem preview de câmera aqui: a gravação abre a câmera nativa do
  // aparelho (fora do app), então não há nada pra mostrar nesta tela
  // enquanto se espera o toque no botão. Os botões ficam centralizados
  // no espaço que sobrou.
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
});
