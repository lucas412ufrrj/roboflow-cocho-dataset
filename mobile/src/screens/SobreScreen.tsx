import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Updates from "expo-updates";

import { CHANGELOG } from "@/data/changelog";
import { obterChaveAdmin, salvarChaveAdmin } from "@/services/adminKey";

function formatarDataHora(data: Date): string {
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${dois(data.getDate())}/${dois(data.getMonth() + 1)}/${data.getFullYear()} ${dois(
    data.getHours()
  )}:${dois(data.getMinutes())}`;
}

function Linha({ label, valor }: { label: string; valor: string }) {
  return (
    <View style={styles.linha}>
      <Text style={styles.linhaLabel}>{label}</Text>
      <Text style={styles.linhaValor} numberOfLines={2}>
        {valor}
      </Text>
    </View>
  );
}

/**
 * Tela de diagnóstico simples: pra quando alguém da equipe reportar um
 * problema e for preciso saber se todo mundo está com a mesma versão
 * instalada, sem precisar comparar prints de tela por tela.
 *
 * Usa só o `expo-updates` que já estava instalado — não a versão estática do
 * `app.json` (que não muda em atualizações via `eas update`, só em builds
 * novas; ver `services/buildCheck.ts`, que usa exatamente essa versão
 * estática via `expo-constants` pra detectar build desatualizada). A "versão
 * do changelog" serve de referência prática de qual leva de mudanças está
 * rodando.
 */
export function SobreScreen() {
  const insets = useSafeAreaInsets();
  const versaoChangelog = CHANGELOG[0]?.versao ?? "—";
  const atualizacaoAplicada = Updates.isEmbeddedLaunch
    ? "Nenhuma — instalada direto do instalador (.apk)"
    : Updates.createdAt
      ? formatarDataHora(Updates.createdAt)
      : "—";

  // Chave de administrador (ver `services/adminKey.ts`): configurada só
  // no(s) aparelho(s) de quem administra a lista de cochos. Sem ela,
  // `CochosScreen` esconde cadastro/edição/exclusão — a pessoa só
  // seleciona cochos já cadastrados.
  const [chaveAdmin, setChaveAdmin] = useState("");
  const [statusChave, setStatusChave] = useState<string | null>(null);

  useEffect(() => {
    obterChaveAdmin().then((chave) => setChaveAdmin(chave ?? ""));
  }, []);

  async function salvar() {
    await salvarChaveAdmin(chaveAdmin);
    setStatusChave(chaveAdmin.trim() ? "Salva neste aparelho." : "Removida deste aparelho.");
  }

  return (
    <ScrollView
      style={styles.tela}
      contentContainerStyle={[styles.conteudo, { paddingBottom: insets.bottom + 32 }]}
    >
      <Text style={styles.titulo}>Calculadora de cocho</Text>
      <Text style={styles.subtitulo}>
        Informações desta instalação — úteis pra conferir se todo mundo da equipe está com a mesma
        versão.
      </Text>

      <View style={styles.bloco}>
        <Linha label="Versão (changelog)" valor={versaoChangelog} />
        <Linha label="Atualização aplicada" valor={atualizacaoAplicada} />
        <Linha label="Canal" valor={Updates.channel ?? "—"} />
        <Linha label="Runtime version" valor={Updates.runtimeVersion ?? "—"} />
        {Updates.updateId && <Linha label="ID da atualização" valor={Updates.updateId.slice(0, 8)} />}
      </View>

      <View style={styles.bloco}>
        <Text style={styles.blocoTitulo}>Administração</Text>
        <Text style={styles.subtitulo}>
          Chave de administrador — só quem administra a lista de cochos precisa configurar isto. Sem ela,
          a tela de Cochos fica só leitura (selecionar cochos já cadastrados).
        </Text>
        <TextInput
          style={styles.input}
          value={chaveAdmin}
          onChangeText={(texto) => {
            setChaveAdmin(texto);
            setStatusChave(null);
          }}
          placeholder="Chave de administrador"
          placeholderTextColor="#8A8F98"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable style={styles.botaoSalvar} onPress={salvar} hitSlop={8}>
          <Text style={styles.botaoSalvarTexto}>Salvar</Text>
        </Pressable>
        {statusChave && <Text style={styles.statusChave}>{statusChave}</Text>}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  tela: { flex: 1, backgroundColor: "#101820" },
  conteudo: { padding: 20, gap: 20 },
  titulo: { color: "#F5F5F5", fontSize: 20, fontWeight: "700" },
  subtitulo: { color: "#8A8F98", fontSize: 13, lineHeight: 19 },
  bloco: {
    backgroundColor: "#161F2A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#232E3B",
    padding: 16,
    gap: 14,
  },
  linha: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  linhaLabel: { color: "#8A8F98", fontSize: 13 },
  linhaValor: { color: "#F5F5F5", fontSize: 13, fontWeight: "600", flexShrink: 1, textAlign: "right" },
  blocoTitulo: { color: "#F5F5F5", fontSize: 15, fontWeight: "700" },
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
  botaoSalvar: {
    backgroundColor: "#3D8BFD",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  botaoSalvarTexto: { color: "#0A1016", fontSize: 14, fontWeight: "700" },
  statusChave: { color: "#8A8F98", fontSize: 12 },
});
