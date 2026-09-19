import { useRef } from "react";
import { NavigationContainer, type NavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import type { CaptureFormData, Cocho, SelectedVideo, TipoAlimento } from "@/types/capture";
import { registrarRotaAtual } from "@/services/navigationTracker";
import { LobbyScreen } from "@/screens/LobbyScreen";
import { CochosScreen } from "@/screens/CochosScreen";
import { TiposAlimentoScreen } from "@/screens/TiposAlimentoScreen";
import { CaptureFormScreen } from "@/screens/CaptureFormScreen";
import { RecordVideoScreen } from "@/screens/RecordVideoScreen";
import { PreviewScreen } from "@/screens/PreviewScreen";
import { UploadStatusScreen } from "@/screens/UploadStatusScreen";
import { HistoricoScreen } from "@/screens/HistoricoScreen";
import { SobreScreen } from "@/screens/SobreScreen";
import { HistoricoHeaderLink } from "@/components/HistoricoHeaderLink";

export type RootStackParamList = {
  Lobby: undefined;
  // A pessoa é obrigada a passar por aqui antes de "Tipo de alimento" — ver
  // `LobbyScreen.tsx` e `CochosScreen.tsx`.
  Cochos: undefined;
  // Obrigatória depois de "Cochos" e antes de "Nova captura" — ver
  // `CochosScreen.tsx` e `TiposAlimentoScreen.tsx`.
  TiposAlimento: { cocho: Cocho };
  CaptureForm: { cocho: Cocho; tipoAlimento: TipoAlimento };
  RecordVideo: { form: CaptureFormData };
  Preview: { form: CaptureFormData; video: SelectedVideo };
  // Só o captureId: os dados da captura (form + vídeo) já estão na fila
  // local (offlineQueue) a partir do momento em que a Prévia é confirmada.
  UploadStatus: { captureId: string };
  Historico: undefined;
  Sobre: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  const navigationRef = useRef<NavigationContainerRef<RootStackParamList>>(null);

  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => registrarRotaAtual(navigationRef.current?.getCurrentRoute()?.name)}
      onStateChange={() => registrarRotaAtual(navigationRef.current?.getCurrentRoute()?.name)}
    >
      <Stack.Navigator
        initialRouteName="Lobby"
        screenOptions={{
          headerStyle: { backgroundColor: "#101820" },
          headerTintColor: "#F5F5F5",
          contentStyle: { backgroundColor: "#101820" },
        }}
      >
        <Stack.Screen
          name="Lobby"
          component={LobbyScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="Cochos"
          component={CochosScreen}
          options={({ navigation }) => ({
            title: "Cochos",
            headerRight: () => <HistoricoHeaderLink navigation={navigation} />,
          })}
        />
        <Stack.Screen
          name="TiposAlimento"
          component={TiposAlimentoScreen}
          options={({ navigation }) => ({
            title: "Tipo de alimento",
            headerRight: () => <HistoricoHeaderLink navigation={navigation} />,
          })}
        />
        <Stack.Screen
          name="CaptureForm"
          component={CaptureFormScreen}
          options={({ navigation }) => ({
            title: "Nova captura",
            headerRight: () => <HistoricoHeaderLink navigation={navigation} />,
          })}
        />
        <Stack.Screen
          name="Historico"
          component={HistoricoScreen}
          options={{ title: "Histórico de envios" }}
        />
        <Stack.Screen
          name="Sobre"
          component={SobreScreen}
          options={{ title: "Sobre" }}
        />
        <Stack.Screen
          name="RecordVideo"
          component={RecordVideoScreen}
          options={{ title: "Gravar ou selecionar vídeo" }}
        />
        <Stack.Screen
          name="Preview"
          component={PreviewScreen}
          options={{ title: "Prévia do vídeo" }}
        />
        <Stack.Screen
          name="UploadStatus"
          component={UploadStatusScreen}
          options={{ title: "Envio", headerBackVisible: false }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
