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
import { listarCochosNoBackend } from "@/api/client";
import { obterChaveAdmin } from "@/services/adminKey";
import {
  editarCocho,
  excluirCocho,
  listarCochos,
  listarCochosNaoSincronizados,
  listarExclusoesPendentes,
  mesclarComServidor,
  registrarCocho,
  type CochoRegistrado,
} from "@/services/cochoStorage";
import { sincronizarCochos, subscribeSincronizacaoCochos } from "@/services/cochoSync";
import { parsePesoInput } from "@/utils/peso";

type Props = NativeStackScreenProps<RootStackParamList, "Cochos">;

export function CochosScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const [cochos, setCochos] = useState<CochoRegistrado[]>([]);
  const [carregando, setCarregando] = useState(true);
  // Chave de administrador configurada neste aparelho (ver
  // `screens/SobreScreen.tsx` e `services/adminKey.ts`). `undefined` =
  // aparelho só-leitura: esconde "Registrar cocho" e o menu de editar/excluir.
  const [chaveAdmin, setChaveAdmin] = useState<string | undefined>(undefined);
  // Quantos cadastros/exclusões deste aparelho ainda não chegaram ao
  // backend (ver `cochoSync.ts`). Só importa pra quem tem a chave de admin —
  // é quem pode perder esse cadastro de verdade se desinstalar o app ou
  // trocar de aparelho antes da sincronização terminar (ver decisão
  // registrada no projeto Claude, 2026-09-20).
  const [pendentesSincronizar, setPendentesSincronizar] = useState(0);

  const [modalVisivel, setModalVisivel] = useState(false);
  // `null` = cadastrando um cocho novo; preenchido = editando esse cocho.
  const [cochoEmEdicao, setCochoEmEdicao] = useState<CochoRegistrado | null>(null);
  const [nome, setNome] = useState("");
  const [comprimento, setComprimento] = useState("");
  const [largura, setLargura] = useState("");
  const [altura, setAltura] = useState("");
  // Separado do `id` (gerado no aparelho): rótulo livre pra depois comparar
  // desempenho entre cochos, ex.: "2026" ou um nome de experimento — ver
  // `types/capture.ts`.
  const [experimento, setExperimento] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  // Cocho cujo menu de opções (editar/excluir) está aberto no momento.
  const [menuAberto, setMenuAberto] = useState<CochoRegistrado | null>(null);

  // Só recalcula a contagem (não a lista principal) — chamada de novo depois
  // de qualquer sincronização em segundo plano, pra o aviso sumir assim que
  // o cadastro pendente for confirmado no backend.
  const atualizarPendentes = useCallback(() => {
    Promise.all([listarCochosNaoSincronizados(), listarExclusoesPendentes()]).then(
      ([naoSincronizados, exclusoes]) => setPendentesSincronizar(naoSincronizados.length + exclusoes.length)
    );
  }, []);

  const carregarCochos = useCallback(() => {
    obterChaveAdmin().then(setChaveAdmin);
    listarCochos()
      .then(setCochos)
      .finally(() => setCarregando(false));
    atualizarPendentes();
    // Busca a lista compartilhada com a equipe em segundo plano, sem
    // atrasar a exibição da cópia local (uso offline em campo). Falha de
    // rede aqui é silenciosa — a pessoa continua vendo a última cópia local
    // conhecida, igual ao resto da sincronização de cochos (ver
    // `cochoSync.ts`).
    listarCochosNoBackend()
      .then((doServidor) => mesclarComServidor(doServidor))
      .then(setCochos)
      .catch(() => undefined);
  }, [atualizarPendentes]);

  // Mantém o aviso de pendência atualizado mesmo com a tela já aberta e em
  // foco, quando a sincronização vem de um gatilho global (`App.tsx`: abrir
  // o app, voltar ao primeiro plano, wifi conectar) — sem isso, o aviso só
  // era recalculado ao ganhar foco (`useFocusEffect` abaixo) ou logo depois
  // de uma ação feita nesta própria tela, e ficava preso desatualizado
  // mesmo com o cadastro já sincronizado de verdade (ver decisão registrada
  // no projeto Claude, 2026-09-20).
  useEffect(() => subscribeSincronizacaoCochos(atualizarPendentes), [atualizarPendentes]);

  // Recarrega toda vez que a aba ganha foco — cobre tanto o retorno de uma
  // nova captura quanto qualquer cadastro/edição/exclusão feita no próprio
  // modal abaixo, ou uma chave de administrador configurada na tela Sobre.
  useFocusEffect(
    useCallback(() => {
      carregarCochos();
    }, [carregarCochos])
  );

  function abrirModalNovo() {
    setCochoEmEdicao(null);
    setNome("");
    setComprimento("");
    setLargura("");
    setAltura("");
    setExperimento("");
    setErro(null);
    setModalVisivel(true);
  }

  function abrirModalEdicao(cocho: CochoRegistrado) {
    setMenuAberto(null);
    setCochoEmEdicao(cocho);
    setNome(cocho.nome);
    setComprimento(String(cocho.comprimentoCm));
    setLargura(String(cocho.larguraCm));
    setAltura(String(cocho.alturaCm));
    setExperimento(cocho.experimento);
    setErro(null);
    setModalVisivel(true);
  }

  function confirmarExclusao(cocho: CochoRegistrado) {
    setMenuAberto(null);
    Alert.alert(
      "Excluir cocho?",
      `"${cocho.nome}" vai sair da lista. Capturas já feitas com esse cocho não são afetadas.`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Excluir",
          style: "destructive",
          onPress: async () => {
            await excluirCocho(cocho.id);
            setCochos((atual) => atual.filter((item) => item.id !== cocho.id));
            // Silencioso de propósito (ver `cochoSync.ts`) — nunca bloqueia
            // nem mostra erro se falhar.
            sincronizarCochos()
              .catch(() => undefined)
              .finally(atualizarPendentes);
          },
        },
      ]
    );
  }

  async function salvarCocho() {
    const nomeAparado = nome.trim();
    if (!nomeAparado) {
      setErro('Dê um nome ao cocho (ex.: "cocho baia 3").');
      return;
    }
    const comprimentoCm = parsePesoInput(comprimento);
    const larguraCm = parsePesoInput(largura);
    const alturaCm = parsePesoInput(altura);
    if (comprimentoCm === null || larguraCm === null || alturaCm === null) {
      setErro("Preencha comprimento, largura e altura em cm (ex.: 120).");
      return;
    }
    const experimentoAparado = experimento.trim();
    if (!experimentoAparado) {
      setErro('Preencha o experimento/ano deste cocho (ex.: "2026").');
      return;
    }

    const dados = { nome: nomeAparado, comprimentoCm, larguraCm, alturaCm, experimento: experimentoAparado };

    if (cochoEmEdicao) {
      const atualizado = await editarCocho(cochoEmEdicao.id, dados);
      if (atualizado) {
        setCochos((atual) => atual.map((item) => (item.id === atualizado.id ? atualizado : item)));
      }
    } else {
      const novo = await registrarCocho(dados);
      setCochos((atual) => [novo, ...atual]);
    }

    setModalVisivel(false);
    // Silencioso de propósito (ver `cochoSync.ts`) — nunca bloqueia o fluxo
    // de cadastro nem mostra erro se falhar.
    sincronizarCochos()
      .catch(() => undefined)
      .finally(atualizarPendentes);
  }

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom + 16 }]}>
      <Text style={styles.subtitulo}>Selecione o cocho que aparece neste vídeo, ou cadastre um novo.</Text>

      <FlatList
        data={cochos}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.lista}
        ListEmptyComponent={
          !carregando ? (
            <Text style={styles.vazio}>
              {chaveAdmin
                ? 'Nenhum cocho cadastrado ainda. Toque em "Registrar cocho" para começar.'
                : "Nenhum cocho cadastrado ainda."}
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.cocho}>
            <Pressable
              style={styles.cochoConteudo}
              onPress={() => navigation.navigate("TiposAlimento", { cocho: item })}
            >
              <View style={styles.cochoTextos}>
                <Text style={styles.cochoNome}>{item.nome}</Text>
                <Text style={styles.cochoMedidas}>
                  {item.comprimentoCm} × {item.larguraCm} × {item.alturaCm} cm (C × L × A)
                </Text>
                <Text style={styles.cochoExperimento}>Experimento: {item.experimento}</Text>
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
          <Text style={styles.botaoRegistrarTexto}>Registrar cocho</Text>
        </Pressable>
      )}

      {/* Menu de opções (editar/excluir) do cocho tocado no "⋮". */}
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

      {/* Cadastro/edição de cocho — mesma tela, `cochoEmEdicao` decide o modo. */}
      <Modal visible={modalVisivel} transparent animationType="fade" onRequestClose={() => setModalVisivel(false)}>
        <KeyboardAvoidingView style={styles.modalFundo} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.modalCartao}>
            <Text style={styles.modalTitulo}>{cochoEmEdicao ? "Editar cocho" : "Novo cocho"}</Text>

            <Text style={styles.label}>Nome *</Text>
            <TextInput
              style={styles.input}
              value={nome}
              onChangeText={setNome}
              placeholder="Ex.: cocho baia 3"
              placeholderTextColor="#8A8F98"
              autoFocus
            />

            <Text style={styles.label}>Comprimento interno (cm) *</Text>
            <TextInput
              style={styles.input}
              value={comprimento}
              onChangeText={setComprimento}
              placeholder="Ex.: 200"
              placeholderTextColor="#8A8F98"
              keyboardType="decimal-pad"
            />

            <Text style={styles.label}>Largura interna (cm) *</Text>
            <TextInput
              style={styles.input}
              value={largura}
              onChangeText={setLargura}
              placeholder="Ex.: 40"
              placeholderTextColor="#8A8F98"
              keyboardType="decimal-pad"
            />

            <Text style={styles.label}>Altura (cm) *</Text>
            <Text style={styles.ajuda}>
              Do fundo até o ponto mais alto que o alimento alcançaria com o cocho cheio (lotação máxima) — não
              necessariamente a borda física do cocho.
            </Text>
            <TextInput
              style={styles.input}
              value={altura}
              onChangeText={setAltura}
              placeholder="Ex.: 30"
              placeholderTextColor="#8A8F98"
              keyboardType="decimal-pad"
            />

            <Text style={styles.label}>Experimento/ano *</Text>
            <Text style={styles.ajuda}>
              Separado do nome — serve pra comparar desempenho entre cochos depois (ex.: "2026").
            </Text>
            <TextInput
              style={styles.input}
              value={experimento}
              onChangeText={setExperimento}
              placeholder="Ex.: 2026"
              placeholderTextColor="#8A8F98"
              autoCapitalize="none"
            />

            {erro && <Text style={styles.erro}>{erro}</Text>}

            <View style={styles.modalBotoes}>
              <Pressable style={styles.modalBotaoCancelar} onPress={() => setModalVisivel(false)} hitSlop={8}>
                <Text style={styles.modalBotaoCancelarTexto}>Cancelar</Text>
              </Pressable>
              <Pressable style={styles.modalBotaoSalvar} onPress={salvarCocho} hitSlop={8}>
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
  cocho: {
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
  cochoConteudo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 10,
  },
  cochoTextos: { flex: 1, gap: 3 },
  cochoNome: { color: "#F5F5F5", fontSize: 16, fontWeight: "700" },
  cochoMedidas: { color: "#8A8F98", fontSize: 12 },
  cochoExperimento: { color: "#6E7580", fontSize: 11 },
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
