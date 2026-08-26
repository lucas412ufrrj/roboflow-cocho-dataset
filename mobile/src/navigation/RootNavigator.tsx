import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import type { CaptureFormData, SelectedVideo } from "@/types/capture";
import { CaptureFormScreen } from "@/screens/CaptureFormScreen";
import { RecordVideoScreen } from "@/screens/RecordVideoScreen";
import { PreviewScreen } from "@/screens/PreviewScreen";
import { UploadStatusScreen } from "@/screens/UploadStatusScreen";

export type RootStackParamList = {
  CaptureForm: undefined;
  RecordVideo: { form: CaptureFormData };
  Preview: { form: CaptureFormData; video: SelectedVideo };
  UploadStatus: { form: CaptureFormData; video: SelectedVideo; captureId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="CaptureForm"
        screenOptions={{
          headerStyle: { backgroundColor: "#101820" },
          headerTintColor: "#F5F5F5",
          contentStyle: { backgroundColor: "#101820" },
        }}
      >
        <Stack.Screen
          name="CaptureForm"
          component={CaptureFormScreen}
          options={{ title: "Nova captura" }}
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
