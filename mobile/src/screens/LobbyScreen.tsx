import { useEffect, useState } from "react";
import { Image, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "@/navigation/RootNavigator";
import { usePendingCount } from "@/hooks/usePendingCount";
import { obterNomeOperador, salvarNomeOperador } from "@/services/operador";
import { abrirChangelog, verificarEAbrirChangelogSeNovo } from "@/services/changelogControl";

type Props = NativeStackScreenProps<RootStackParamList, "Lobby">;

export function LobbyScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const pendentes = usePendingCount();

  // Nome de quem está gravando neste aparelho — obrigatório, pedido uma
  // única vez (na primeira abertura do app, antes de deixar usar qualquer
  // opção da Lobby) e depois anexado automaticamente a cada captura (ver
  // `services/operador.ts` e `PreviewScreen.confirmarEEnviar`). Pode ser
  // trocado depois pelo link no rodapé, mas nunca deixado em branco.
  const [operador, setOperador] = useState<string | undefined>(undefined);
  const [carregandoOperador, setCarregandoOperador] = useState(true);
  const [editandoOperador, setEditandoOperador] = useState(false);
  const [rascunhoOperador, setRascunhoOperador] = useState("");
  const [erroOperador, setErroOperador] = useState<string | null>(null);

  useEffect(() => {
    obterNomeOperador().then((nome) => {
      setOperador(nome);
      setCarregandoOperador(false);
      // Nunca configurado neste aparelho: abre o modal já na Lobby, sem
      // esperar a pessoa procurar o link no rodapé.
      if (!nome) {
        setRascunhoOperador("");
        setEditandoOperador(true);
      }
    });
  }, []);

  function abrirEdicaoOperador() {
    setRascunhoOperador(operador ?? "");
    setErroOperador(null);
    setEditandoOperador(true);
  }

  function cancelarEdicaoOperador() {
    // Só pode fechar sem salvar se já existir um nome configurado — enquanto
    // não houver nenhum, o modal é obrigatório.
    if (!operador) return;
    setEditandoOperador(false);
    setErroOperador(null);
  }

  async function salvarOperador() {
    const nome = rascunhoOperador.trim();
    if (!nome) {
      setErroOperador("Informe seu nome para continuar.");
      return;
    }
    const eraPrimeiraConfiguracao = !operador;
    await salvarNomeOperador(nome);
    setOperador(nome);
    setErroOperador(null);
    setEditandoOperador(false);
    // Só depois do modal obrigatório de nome ser resolvido é que a tela de
    // novidades pode competir por atenção (ver App.tsx e
    // `verificarEAbrirChangelogSeNovo`) — evita os dois modais abrindo
    // juntos na primeira instalação.
    if (eraPrimeiraConfiguracao) {
      verificarEAbrirChangelogSeNovo();
    }
  }

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 },
      ]}
    >
      <View style={styles.miolo}>
        <View style={styles.areaLogo}>
          <Image
            source={require("../../assets/logo-gado-corte.png")}
            style={styles.logo}
            resizeMode="contain"
          />
        </View>

        {pendentes > 0 && (
          <Pressable style={styles.avisoPendente} onPress={() => navigation.navigate("Historico")}>
            <Text style={styles.avisoPendenteTexto}>
              {pendentes} {pendentes === 1 ? "captura" : "capturas"} aguardando envio
            </Text>
            <Text style={styles.avisoPendenteSeta}>›</Text>
          </Pressable>
        )}

        <View style={styles.opcoes}>
          <Pressable
            style={({ pressed }) => [styles.opcao, styles.opcaoAtiva, pressed && styles.opcaoPressionada]}
            onPress={() => navigation.navigate("Cochos")}
          >
            <View style={styles.opcaoTextos}>
              <Text style={styles.opcaoTitulo}>Adicionar imagens ao dataset</Text>
              <Text style={styles.opcaoSubtitulo}>
                Gravar ou selecionar um vídeo de um cocho
              </Text>
            </View>

            <Text style={styles.seta}>›</Text>
          </Pressable>

          <View style={[styles.opcao, styles.opcaoDesabilitada]}>
            <View style={styles.opcaoTextos}>
              <Text style={[styles.opcaoTitulo, styles.textoDesabilitado]}>
                Estimar peso por imagem
              </Text>
              <Text style={styles.opcaoSubtitulo}>Predição direto pela câmera</Text>
            </View>

            <View style={styles.emBreveBadge}>
              <Text style={styles.emBreveTexto}>EM BREVE</Text>
            </View>
          </View>
        </View>
      </View>

      {!carregandoOperador && (
        <Pressable style={styles.linkOperador} onPress={abrirEdicaoOperador} hitSlop={8}>
          <Text style={styles.linkOperadorTexto}>Operador(a): {operador} · editar</Text>
        </Pressable>
      )}

      <View style={styles.linksRodape}>
        <Pressable style={styles.linkSobre} onPress={() => navigation.navigate("Sobre")} hitSlop={8}>
          <Text style={styles.linkSobreTexto}>Versão</Text>
        </Pressable>
        <Text style={styles.linksRodapeSeparador}>·</Text>
        <Pressable style={styles.linkSobre} onPress={abrirChangelog} hitSlop={8}>
          <Text style={styles.linkSobreTexto}>O que há de novo?</Text>
        </Pressable>
      </View>

      <Modal
        visible={editandoOperador}
        transparent
        animationType="fade"
        onRequestClose={cancelarEdicaoOperador}
      >
        <View style={styles.modalFundo}>
          <View style={styles.modalCartao}>
            <Text style={styles.modalTitulo}>Quem está gravando?</Text>
            <Text style={styles.modalSubtitulo}>
              Esse nome fica salvo neste aparelho e é anexado a cada captura enviada — ajuda a
              rastrear de onde veio cada vídeo.
            </Text>

            <TextInput
              style={styles.modalInput}
              value={rascunhoOperador}
              onChangeText={(texto) => {
                setRascunhoOperador(texto);
                if (erroOperador) setErroOperador(null);
              }}
              placeholder="Seu nome"
              placeholderTextColor="#5A6270"
              autoFocus
              onSubmitEditing={salvarOperador}
            />
            {erroOperador && <Text style={styles.modalErro}>{erroOperador}</Text>}

            <View style={styles.modalBotoes}>
              {operador && (
                <Pressable style={styles.modalBotaoCancelar} onPress={cancelarEdicaoOperador} hitSlop={8}>
                  <Text style={styles.modalBotaoCancelarTexto}>Cancelar</Text>
                </Pressable>
              )}
              <Pressable style={styles.modalBotaoSalvar} onPress={salvarOperador} hitSlop={8}>
                <Text style={styles.modalBotaoSalvarTexto}>Salvar</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#101820",
    paddingHorizontal: 24,
    justifyContent: "space-between",
  },
  miolo: {
    flex: 1,
    justifyContent: "center",
    gap: 28,
  },
  areaLogo: {
    width: "100%",
    aspectRatio: 16 / 9,
    alignItems: "center",
    justifyContent: "center",
  },
  logo: {
    width: 208,
    maxWidth: "70%",
    aspectRatio: 1000 / 848,
  },
  opcoes: {
    width: "100%",
    gap: 14,
  },
  opcao: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#161F2A",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#232E3B",
    paddingVertical: 18,
    paddingHorizontal: 16,
    gap: 14,
  },
  opcaoAtiva: {
    borderColor: "#3D8BFD55",
    shadowColor: "#3D8BFD",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 6,
  },
  opcaoPressionada: {
    opacity: 0.82,
    transform: [{ scale: 0.99 }],
  },
  opcaoDesabilitada: {
    opacity: 0.6,
  },
  opcaoTextos: {
    flex: 1,
    gap: 3,
  },
  opcaoTitulo: {
    color: "#F5F5F5",
    fontSize: 16,
    fontWeight: "700",
  },
  opcaoSubtitulo: {
    color: "#8A8F98",
    fontSize: 12,
  },
  textoDesabilitado: {
    color: "#C7CAD1",
  },
  seta: {
    color: "#3D8BFD",
    fontSize: 26,
    fontWeight: "700",
  },
  emBreveBadge: {
    backgroundColor: "#FFB02022",
    borderWidth: 1,
    borderColor: "#FFB020",
    borderRadius: 20,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  emBreveTexto: {
    color: "#FFB020",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  avisoPendente: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#3D8BFD18",
    borderWidth: 1,
    borderColor: "#3D8BFD55",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  avisoPendenteTexto: { color: "#3D8BFD", fontSize: 13, fontWeight: "700" },
  avisoPendenteSeta: { color: "#3D8BFD", fontSize: 20, fontWeight: "700" },
  linksRodape: {
    flexDirection: "row",
    alignSelf: "center",
    alignItems: "center",
    gap: 8,
  },
  linksRodapeSeparador: {
    color: "#8A8F98",
    fontSize: 12,
  },
  linkSobre: {
    alignSelf: "center",
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  linkSobreTexto: {
    color: "#8A8F98",
    fontSize: 12,
    textDecorationLine: "underline",
  },
  linkOperador: {
    alignSelf: "center",
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  linkOperadorTexto: {
    color: "#8A8F98",
    fontSize: 12,
  },
  modalFundo: {
    flex: 1,
    backgroundColor: "#00000099",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  modalCartao: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#161F2A",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#232E3B",
    padding: 20,
    gap: 12,
  },
  modalTitulo: {
    color: "#F5F5F5",
    fontSize: 17,
    fontWeight: "700",
  },
  modalSubtitulo: {
    color: "#8A8F98",
    fontSize: 13,
    lineHeight: 18,
  },
  modalInput: {
    color: "#F5F5F5",
    fontSize: 15,
    backgroundColor: "#101820",
    borderWidth: 1,
    borderColor: "#232E3B",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  modalErro: {
    color: "#FF6B6B",
    fontSize: 12,
  },
  modalBotoes: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  modalBotaoCancelar: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  modalBotaoCancelarTexto: {
    color: "#8A8F98",
    fontSize: 14,
    fontWeight: "600",
  },
  modalBotaoSalvar: {
    backgroundColor: "#3D8BFD",
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 16,
  },
  modalBotaoSalvarTexto: {
    color: "#0A1016",
    fontSize: 14,
    fontWeight: "700",
  },
});
