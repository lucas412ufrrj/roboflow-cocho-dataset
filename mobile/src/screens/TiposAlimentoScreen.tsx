import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "@/navigation/RootNavigator";
import { listarTiposAlimentoNoBackend } from "@/api/client";
import { obterChaveAdmin } from "@/services/adminKey";
import {
  editarTipoAlimento,
  excluirTipoAlimento,
  listarExclusoesPendentesTipoAlimento,
  listarTiposAlimento,
  listarTiposAlimentoNaoSincronizados,
  mesclarComServidor,
  registrarTipoAlimento,
  type TipoAlimentoRegistrado,
} from "@/services/tipoAlimentoStorage";
import { sincronizarTiposAlimento, subscribeSincronizacaoTiposAlimento } from "@/services/tipoAlimentoSync";
import { parsePesoInput } from "@/utils/peso";

// Mesma lógica de admin/sincronização de `CochosScreen.tsx` — ver comentários
// lá para o raciocínio completo, não repetido aqui campo a campo.
type Props = NativeStackScreenProps<RootStackParamList, "TiposAlimento">;

export function TiposAlimentoScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { cocho } = route.params;
  const [tipos, setTipos] = useState<TipoAlimentoRegistrado[]>([]);
  const [carregando, setCarregando] = useState(true);
  // Chave de administrador configurada neste aparelho (ver
  // `screens/SobreScreen.tsx` e `services/adminKey.ts`). `undefined` =
  // aparelho só-leitura: esconde "Registrar tipo de alimento" e o menu de
  // editar/excluir.
  const [chaveAdmin, setChaveAdmin] = useState<string | undefined>(undefined);
  // Mesma lógica de `CochosScreen.tsx` — ver comentário lá.
  const [pendentesSincronizar, setPendentesSincronizar] = useState(0);

  const [modalVisivel, setModalVisivel] = useState(false);
  // `null` = cadastrando um tipo novo; preenchido = editando esse tipo.
  const [tipoEmEdicao, setTipoEmEdicao] = useState<TipoAlimentoRegistrado | null>(null);
  const [nome, setNome] = useState("");
  const [densidade, setDensidade] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  // Tipo de alimento cujo menu de opções (editar/excluir) está aberto no momento.
  const [menuAberto, setMenuAberto] = useState<TipoAlimentoRegistrado | null>(null);

  // Mesma lógica de `CochosScreen.atualizarPendentes` — ver comentário lá.
  const atualizarPendentes = useCallback(() => {
    Promise.all([listarTiposAlimentoNaoSincronizados(), listarExclusoesPendentesTipoAlimento()]).then(
      ([naoSincronizados, exclusoes]) => setPendentesSincronizar(naoSincronizados.length + exclusoes.length)
    );
  }, []);

  const carregarTipos = useCallback(() => {
    obterChaveAdmin().then(setChaveAdmin);
    listarTiposAlimento()
      .then(setTipos)
      .finally(() => setCarregando(false));
    atualizarPendentes();
    // Busca a lista compartilhada com a equipe em segundo plano, sem
    // atrasar a exibição da cópia local (uso offline em campo). Falha de
    // rede aqui é silenciosa — a pessoa continua vendo a última cópia local
    // conhecida, igual ao resto da sincronização de tipos de alimento (ver
    // `tipoAlimentoSync.ts`).
    listarTiposAlimentoNoBackend()
      .then((doServidor) => mesclarComServidor(doServidor))
      .then(setTipos)
      .catch(() => undefined);
  }, [atualizarPendentes]);

  // Mantém o aviso de pendência atualizado com a tela já aberta e em foco —
  // mesma lógica de `CochosScreen.tsx`, ver comentário lá.
  useEffect(() => subscribeSincronizacaoTiposAlimento(atualizarPendentes), [atualizarPendentes]);

  // Recarrega toda vez que a tela ganha foco — cobre tanto o retorno de uma
  // nova captura quanto qualquer cadastro/edição/exclusão feita no próprio
  // modal abaixo, ou uma chave de administrador configurada na tela Sobre.
  useFocusEffect(
    useCallback(() => {
      carregarTipos();
    }, [carregarTipos])
  );

  function abrirModalNovo() {
    setTipoEmEdicao(null);
    setNome("");
    setDensidade("");
    setErro(null);
    setModalVisivel(true);
  }

  function abrirModalEdicao(tipo: TipoAlimentoRegistrado) {
    setMenuAberto(null);
    setTipoEmEdicao(tipo);
    setNome(tipo.nome);
    setDensidade(String(tipo.densidadeAparenteKgL));
    setErro(null);
    setModalVisivel(true);
  }

  function confirmarExclusao(tipo: TipoAlimentoRegistrado) {
    setMenuAberto(null);
    Alert.alert(
      "Excluir tipo de alimento?",
      `"${tipo.nome}" vai sair da lista. Capturas já feitas com esse tipo não são afetadas.`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Excluir",
          style: "destructive",
          onPress: async () => {
            await excluirTipoAlimento(tipo.id);
            setTipos((atual) => atual.filter((item) => item.id !== tipo.id));
            // Silencioso de propósito (ver `tipoAlimentoSync.ts`) — nunca
            // bloqueia nem mostra erro se falhar.
            sincronizarTiposAlimento()
              .catch(() => undefined)
              .finally(atualizarPendentes);
          },
        },
      ]
    );
  }

  async function salvarTipo() {
    const nomeAparado = nome.trim();
    if (!nomeAparado) {
      setErro('Dê um nome ao tipo de alimento (ex.: "Silagem").');
      return;
    }
    const densidadeAparenteKgL = parsePesoInput(densidade);
    if (densidadeAparenteKgL === null || densidadeAparenteKgL <= 0) {
      setErro("Preencha a densidade aparente em Kg/L (ex.: 0,6).");
      return;
    }

    const dados = { nome: nomeAparado, densidadeAparenteKgL };

    if (tipoEmEdicao) {
      const atualizado = await editarTipoAlimento(tipoEmEdicao.id, dados);
      if (atualizado) {
        setTipos((atual) => atual.map((item) => (item.id === atualizado.id ? atualizado : item)));
      }
    } else {
      const novo = await registrarTipoAlimento(dados);
      setTipos((atual) => [novo, ...atual]);
    }

    setModalVisivel(false);
    // Silencioso de propósito (ver `tipoAlimentoSync.ts`) — nunca bloqueia o
    // fluxo de cadastro nem mostra erro se falhar.
    sincronizarTiposAlimento()
      .catch(() => undefined)
      .finally(atualizarPendentes);
  }

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom + 16 }]}>
      <Text style={styles.subtitulo}>Selecione o tipo de alimento deste vídeo, ou cadastre um novo.</Text>

      <FlatList
        data={tipos}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.lista}
        ListEmptyComponent={
          !carregando ? (
            <Text style={styles.vazio}>
              {chaveAdmin
                ? 'Nenhum tipo de alimento cadastrado ainda. Toque em "Registrar tipo de alimento" para começar.'
                : "Nenhum tipo de alimento cadastrado ainda."}
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.tipo}>
            <Pressable
              style={styles.tipoConteudo}
              onPress={() => navigation.navigate("CaptureForm", { cocho, tipoAlimento: item })}
            >
              <View style={styles.tipoTextos}>
                <Text style={styles.tipoNome}>{item.nome}</Text>
                <Text style={styles.tipoDensidade}>Densidade aparente: {item.densidadeAparenteKgL} Kg/L</Text>
              </View>
            </Pressable>
            {chaveAdmin && (
              <Pressable style={styles.botaoMenu} onPress={() => setMenuAberto(item)} hitSlop={10}>
                <Text style={styles.menuIcone}>⋮</Text>
              </Pressable>
            )}
          </View>
        )}
      />

      {chaveAdmin && pendentesSincronizar > 0 && (
        <Text style={styles.avisoPendente}>
          {pendentesSincronizar === 1
            ? "1 alteração ainda não sincronizou com o servidor. Evite desinstalar o app ou trocar de aparelho antes disso."
            : `${pendentesSincronizar} alterações ainda não sincronizaram com o servidor. Evite desinstalar o app ou trocar de aparelho antes disso.`}
        </Text>
      )}

      {chaveAdmin && (
        <Pressable style={styles.botaoRegistrar} onPress={abrirModalNovo}>
          <Text style={styles.botaoRegistrarTexto}>Registrar tipo de alimento</Text>
        </Pressable>
      )}

      {/* Menu de opções (editar/excluir) do tipo tocado no "⋮". */}
      <Modal visible={menuAberto !== null} transparent animationType="fade" onRequestClose={() => setMenuAberto(null)}>
        <Pressable style={styles.modalFundo} onPress={() => setMenuAberto(null)}>
          <View style={styles.menuCartao}>
            {menuAberto && <Text style={styles.menuTitulo}>{menuAberto.nome}</Text>}
            <Pressable
              style={styles.menuOpcao}
              onPress={() => menuAberto && abrirModalEdicao(menuAberto)}
              hitSlop={4}
            >
              <Text style={styles.menuOpcaoTexto}>Editar</Text>
            </Pressable>
            <Pressable
              style={styles.menuOpcao}
              onPress={() => menuAberto && confirmarExclusao(menuAberto)}
              hitSlop={4}
            >
              <Text style={styles.menuOpcaoTextoExcluir}>Excluir</Text>
            </Pressable>
            <Pressable style={styles.menuOpcao} onPress={() => setMenuAberto(null)} hitSlop={4}>
              <Text style={styles.menuOpcaoTextoCancelar}>Cancelar</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Cadastro/edição de tipo de alimento — mesma tela, `tipoEmEdicao` decide o modo. */}
      <Modal visible={modalVisivel} transparent animationType="fade" onRequestClose={() => setModalVisivel(false)}>
        <KeyboardAvoidingView style={styles.modalFundo} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.modalCartao}>
            <Text style={styles.modalTitulo}>{tipoEmEdicao ? "Editar tipo de alimento" : "Novo tipo de alimento"}</Text>

            <Text style={styles.label}>Nome *</Text>
            <TextInput
              style={styles.input}
              value={nome}
              onChangeText={setNome}
              placeholder="Ex.: Silagem, Ração"
              placeholderTextColor="#8A8F98"
              autoFocus
            />

            <Text style={styles.label}>Densidade aparente (Kg/L) *</Text>
            <Text style={styles.ajuda}>
              Use um frasco de volume conhecido, encha-o e pese para descobrir a densidade aparente.
            </Text>
            <TextInput
              style={styles.input}
              value={densidade}
              onChangeText={setDensidade}
              placeholder="Ex.: 0,6"
              placeholderTextColor="#8A8F98"
              keyboardType="decimal-pad"
            />

            {erro && <Text style={styles.erro}>{erro}</Text>}

            <View style={styles.modalBotoes}>
              <Pressable style={styles.modalBotaoCancelar} onPress={() => setModalVisivel(false)} hitSlop={8}>
                <Text style={styles.modalBotaoCancelarTexto}>Cancelar</Text>
              </Pressable>
              <Pressable style={styles.modalBotaoSalvar} onPress={salvarTipo} hitSlop={8}>
                <Text style={styles.modalBotaoSalvarTexto}>Salvar</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#101820", paddingHorizontal: 20, paddingTop: 16 },
  subtitulo: { color: "#B5B9C0", fontSize: 14, marginBottom: 14 },
  lista: { gap: 10, paddingBottom: 8, flexGrow: 1 },
  vazio: { color: "#8A8F98", fontSize: 14, textAlign: "center", marginTop: 40 },
  tipo: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#161F2A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#232E3B",
    paddingVertical: 4,
    paddingHorizontal: 4,
    gap: 4,
  },
  tipoConteudo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 10,
  },
  tipoTextos: { flex: 1, gap: 3 },
  tipoNome: { color: "#F5F5F5", fontSize: 16, fontWeight: "700" },
  tipoDensidade: { color: "#8A8F98", fontSize: 12 },
  botaoMenu: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  menuIcone: { color: "#8A8F98", fontSize: 20, fontWeight: "700" },
  botaoRegistrar: {
    marginTop: 14,
    backgroundColor: "#3D8BFD",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
  },
  botaoRegistrarTexto: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  avisoPendente: {
    color: "#F5A623",
    fontSize: 12,
    marginTop: 12,
    textAlign: "center",
  },
  modalFundo: {
    flex: 1,
    backgroundColor: "#00000099",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  menuCartao: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: "#161F2A",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#232E3B",
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  menuTitulo: {
    color: "#8A8F98",
    fontSize: 13,
    fontWeight: "600",
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  menuOpcao: {
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: "#232E3B",
  },
  menuOpcaoTexto: { color: "#F5F5F5", fontSize: 15, fontWeight: "600" },
  menuOpcaoTextoExcluir: { color: "#FF6B6B", fontSize: 15, fontWeight: "600" },
  menuOpcaoTextoCancelar: { color: "#8A8F98", fontSize: 15, fontWeight: "600" },
  modalCartao: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: "#161F2A",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#232E3B",
    padding: 20,
    gap: 4,
  },
  modalTitulo: { color: "#F5F5F5", fontSize: 18, fontWeight: "700", marginBottom: 8 },
  label: { color: "#D0D3D8", fontSize: 14, marginTop: 10, marginBottom: 6, fontWeight: "600" },
  ajuda: { color: "#8A8F98", fontSize: 11, marginBottom: 6, lineHeight: 15 },
  input: {
    backgroundColor: "#101820",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#F5F5F5",
    fontSize: 16,
    borderWidth: 1,
    borderColor: "#2A3542",
  },
  erro: { color: "#FF6B6B", marginTop: 10 },
  modalBotoes: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
    marginTop: 16,
  },
  modalBotaoCancelar: { paddingVertical: 8, paddingHorizontal: 12 },
  modalBotaoCancelarTexto: { color: "#8A8F98", fontSize: 14, fontWeight: "600" },
  modalBotaoSalvar: {
    backgroundColor: "#3D8BFD",
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 16,
  },
  modalBotaoSalvarTexto: { color: "#0A1016", fontSize: 14, fontWeight: "700" },
});
