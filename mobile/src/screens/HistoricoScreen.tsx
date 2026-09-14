import { useCallback, useState } from "react";
import { Alert, FlatList, Image, Modal, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";

import { listarHistorico, reconciliarComFila, type HistoricoEntry } from "@/services/historicoEnvios";
import { listQueue } from "@/services/offlineQueue";
import { cancelarCaptura, sincronizarFila, subscribeQueueChanges, temWifiConectado } from "@/services/syncEngine";
import { AnimatedDots } from "@/components/AnimatedDots";

function formatarDataHora(timestamp: number): string {
  const data = new Date(timestamp);
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${dois(data.getDate())}/${dois(data.getMonth() + 1)} ${dois(data.getHours())}:${dois(
    data.getMinutes()
  )}`;
}

const STATUS_INFO: Record<HistoricoEntry["status"], { texto: string; cor: string; fundo: string }> = {
  enviado: { texto: "Enviado", cor: "#3DDC97", fundo: "#3DDC9722" },
  aguardando_sincronizacao: { texto: "Aguardando sincronização", cor: "#3D8BFD", fundo: "#3D8BFD22" },
  cancelado: { texto: "Cancelado", cor: "#8A8F98", fundo: "#8A8F9822" },
};

function percentualAprovado(aceitos: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((aceitos / total) * 100);
}

/** Mesma lógica de cor por faixa usada nos badges de status: verde quando a
 * maioria dos frames passou, amarelo numa faixa intermediária, vermelho
 * quando a captura rendeu poucos frames aprovados — ajuda a notar de
 * relance um vídeo que provavelmente vale regravar. */
function corPercentual(percentual: number): string {
  if (percentual >= 70) return "#3DDC97";
  if (percentual >= 40) return "#FFB020";
  return "#FF6B6B";
}

/** Monta o texto simples enviado pelo compartilhamento nativo — um resumo
 * legível de cada captura, mais recente primeiro (mesma ordem da lista). */
function gerarTextoHistorico(historico: HistoricoEntry[]): string {
  if (historico.length === 0) {
    return "Histórico de capturas — Calculadora de cocho\nNenhuma captura registrada ainda.";
  }

  const linhas = historico.map((item) => {
    const partes = [formatarDataHora(item.createdAt), STATUS_INFO[item.status].texto];
    if (item.pesoKg) partes.push(`${item.pesoKg} kg`);
    if (item.cochoId) partes.push(`Cocho ${item.cochoId}`);
    if (item.status === "enviado" && item.totalFrames !== undefined) {
      const percentual = percentualAprovado(item.framesAceitos ?? 0, item.totalFrames);
      partes.push(`${item.framesAceitos}/${item.totalFrames} frames aprovados (${percentual}%)`);
    }
    return partes.join(" — ");
  });

  const cabecalho = `Histórico de capturas — Calculadora de cocho\n${linhas.length} registro${
    linhas.length === 1 ? "" : "s"
  }`;
  return `${cabecalho}\n\n${linhas.join("\n")}`;
}

function Linha({ item, onAbrirMenu }: { item: HistoricoEntry; onAbrirMenu: (item: HistoricoEntry) => void }) {
  const info = STATUS_INFO[item.status];
  const podeCancelar = item.status === "aguardando_sincronizacao";
  const mostrarFrames = item.status === "enviado" && item.totalFrames !== undefined;
  const percentual = mostrarFrames ? percentualAprovado(item.framesAceitos ?? 0, item.totalFrames as number) : 0;

  return (
    <View style={styles.linha}>
      {item.thumbnailUri ? (
        <Image source={{ uri: item.thumbnailUri }} style={styles.miniatura} />
      ) : (
        // Sem miniatura (capturas de antes desta versão, ou geração que
        // falhou) — um espaço reservado no lugar, pra manter as linhas
        // alinhadas em vez de pular o espaço da imagem.
        <View style={[styles.miniatura, styles.miniaturaVazia]} />
      )}

      <View style={styles.linhaConteudo}>
        <View style={styles.linhaTopo}>
          <Text style={styles.dataHora}>{formatarDataHora(item.createdAt)}</Text>

          <View style={styles.linhaTopoDireita}>
            <View style={[styles.badge, { backgroundColor: info.fundo, borderColor: info.cor }]}>
              <Text style={[styles.badgeTexto, { color: info.cor }]}>{info.texto}</Text>
            </View>

            {podeCancelar && (
              <Pressable style={styles.botaoMenu} onPress={() => onAbrirMenu(item)} hitSlop={10}>
                <Text style={styles.botaoMenuTexto}>⋮</Text>
              </Pressable>
            )}
          </View>
        </View>

        <View style={styles.detalhes}>
          {item.pesoKg && <Text style={styles.detalheTexto}>{item.pesoKg} kg</Text>}
          {item.cochoId && <Text style={styles.detalheTexto}>Cocho {item.cochoId}</Text>}
        </View>

        {mostrarFrames && (
          <Text style={styles.frames}>
            {item.framesAceitos}/{item.totalFrames} frames aprovados ·{" "}
            <Text style={[styles.framesPercentual, { color: corPercentual(percentual) }]}>{percentual}%</Text>
          </Text>
        )}
      </View>
    </View>
  );
}

export function HistoricoScreen() {
  const [historico, setHistorico] = useState<HistoricoEntry[]>([]);
  const [sincronizando, setSincronizando] = useState(false);
  const [itemDoMenu, setItemDoMenu] = useState<HistoricoEntry | null>(null);
  const [cancelando, setCancelando] = useState(false);

  const carregar = useCallback(() => {
    // Antes de listar, preenche qualquer captura que esteja na fila local mas
    // não tenha registro no Histórico — ver comentário em
    // `reconciliarComFila`. Sem isso, uma captura pode contar como pendente
    // em outros cantos do app (ex.: badge da Lobby) sem nunca aparecer aqui.
    listQueue()
      .then((fila) => reconciliarComFila(fila))
      .then(() => listarHistorico())
      .then(setHistorico);
  }, []);

  useFocusEffect(
    useCallback(() => {
      carregar();
      const cancelarAssinatura = subscribeQueueChanges(carregar);
      return cancelarAssinatura;
    }, [carregar])
  );

  const pendentes = historico.filter((item) => item.status === "aguardando_sincronizacao").length;

  async function sincronizarAgora() {
    setSincronizando(true);
    try {
      const temWifi = await temWifiConectado();
      if (!temWifi) {
        Alert.alert("Sem wifi", "Conecte no wifi e tente de novo.");
        return;
      }
      const enviados = await sincronizarFila();
      if (enviados === 0) {
        Alert.alert("Nada enviado", "Não deu pra enviar agora. Os vídeos continuam salvos e o app tenta de novo sozinho.");
      }
    } finally {
      setSincronizando(false);
      carregar();
    }
  }

  async function exportarHistorico() {
    try {
      await Share.share({ message: gerarTextoHistorico(historico) });
    } catch {
      // Compartilhamento cancelado ou indisponível — nada a fazer aqui.
    }
  }

  function confirmarCancelamento() {
    const item = itemDoMenu;
    if (!item) return;
    setItemDoMenu(null);
    Alert.alert(
      "Cancelar envio",
      "O vídeo será apagado do aparelho e não vai ser enviado. Essa ação não pode ser desfeita.",
      [
        { text: "Voltar", style: "cancel" },
        {
          text: "Cancelar envio",
          style: "destructive",
          onPress: async () => {
            setCancelando(true);
            try {
              const resultado = await cancelarCaptura(item.captureId);
              if (!resultado.ok) {
                Alert.alert("Não deu pra cancelar", resultado.motivo);
              }
            } finally {
              setCancelando(false);
              carregar();
            }
          },
        },
      ]
    );
  }

  return (
    <View style={styles.tela}>
      <View style={styles.topoFixo}>
        <Pressable
          style={[styles.botaoSincronizar, (sincronizando || pendentes === 0) && styles.botaoSincronizarDesabilitado]}
          onPress={sincronizarAgora}
          disabled={sincronizando || pendentes === 0}
        >
          {sincronizando ? (
            <View style={styles.linhaSincronizando}>
              <Text style={styles.botaoSincronizarTexto}>Sincronizando</Text>
              <AnimatedDots color="#FFFFFF" size={5} />
            </View>
          ) : (
            <Text style={styles.botaoSincronizarTexto}>
              {pendentes === 0 ? "Nada pendente" : `Sincronizar agora (${pendentes})`}
            </Text>
          )}
        </Pressable>

        <Pressable
          style={[styles.botaoExportar, historico.length === 0 && styles.botaoExportarDesabilitado]}
          onPress={exportarHistorico}
          disabled={historico.length === 0}
        >
          <Text style={styles.botaoExportarTexto}>Exportar histórico</Text>
        </Pressable>
      </View>

      <FlatList
        style={styles.lista}
        contentContainerStyle={historico.length === 0 ? styles.listaVaziaContainer : styles.listaContainer}
        data={historico}
        keyExtractor={(item) => item.captureId}
        renderItem={({ item }) => <Linha item={item} onAbrirMenu={setItemDoMenu} />}
        ListEmptyComponent={
          <View style={styles.vazio}>
            <Text style={styles.vazioTexto}>Nenhuma captura registrada ainda.</Text>
          </View>
        }
      />

      <Modal visible={itemDoMenu !== null} transparent animationType="fade" onRequestClose={() => setItemDoMenu(null)}>
        <Pressable style={styles.overlay} onPress={() => setItemDoMenu(null)}>
          <View style={styles.folhaMenu}>
            {itemDoMenu && <Text style={styles.folhaMenuTitulo}>{formatarDataHora(itemDoMenu.createdAt)}</Text>}

            <Pressable
              style={styles.opcaoMenu}
              onPress={confirmarCancelamento}
              disabled={cancelando}
            >
              <Text style={styles.opcaoMenuTextoDestrutivo}>Cancelar envio</Text>
            </Pressable>

            <Pressable style={styles.opcaoMenu} onPress={() => setItemDoMenu(null)}>
              <Text style={styles.opcaoMenuTexto}>Fechar</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  tela: { flex: 1, backgroundColor: "#101820" },
  topoFixo: { padding: 20, paddingBottom: 4, gap: 10 },
  botaoSincronizar: {
    backgroundColor: "#3D8BFD",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  botaoSincronizarDesabilitado: {
    backgroundColor: "#354456",
  },
  botaoSincronizarTexto: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
  linhaSincronizando: { flexDirection: "row", alignItems: "center", gap: 8 },
  botaoExportar: {
    borderWidth: 1,
    borderColor: "#3D8BFD55",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  botaoExportarDesabilitado: { opacity: 0.4 },
  botaoExportarTexto: { color: "#3D8BFD", fontSize: 14, fontWeight: "700" },
  lista: { flex: 1 },
  listaContainer: { padding: 20, paddingTop: 12, gap: 12 },
  listaVaziaContainer: { flex: 1 },
  vazio: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
  vazioTexto: { color: "#8A8F98", fontSize: 14, textAlign: "center" },
  linha: {
    flexDirection: "row",
    backgroundColor: "#161F2A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#232E3B",
    padding: 14,
    gap: 12,
  },
  miniatura: {
    width: 56,
    height: 56,
    borderRadius: 10,
    backgroundColor: "#101820",
  },
  miniaturaVazia: {
    borderWidth: 1,
    borderColor: "#232E3B",
  },
  linhaConteudo: {
    flex: 1,
    gap: 8,
  },
  linhaTopo: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  linhaTopoDireita: { flexDirection: "row", alignItems: "center", gap: 6 },
  dataHora: { color: "#F5F5F5", fontSize: 14, fontWeight: "700" },
  badge: {
    borderRadius: 20,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderWidth: 1,
  },
  badgeTexto: { fontSize: 10, fontWeight: "800", letterSpacing: 0.3 },
  botaoMenu: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  botaoMenuTexto: { color: "#8A8F98", fontSize: 18, fontWeight: "800", lineHeight: 18 },
  detalhes: { flexDirection: "row", gap: 14 },
  detalheTexto: { color: "#8A8F98", fontSize: 12 },
  frames: { color: "#B5B9C0", fontSize: 12 },
  framesPercentual: { fontWeight: "800" },
  overlay: {
    flex: 1,
    backgroundColor: "#00000088",
    justifyContent: "flex-end",
  },
  folhaMenu: {
    backgroundColor: "#161F2A",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 12,
    paddingBottom: 32,
    paddingHorizontal: 20,
    gap: 4,
    borderTopWidth: 1,
    borderColor: "#232E3B",
  },
  folhaMenuTitulo: {
    color: "#8A8F98",
    fontSize: 12,
    textAlign: "center",
    marginBottom: 8,
  },
  opcaoMenu: {
    paddingVertical: 16,
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#232E3B",
  },
  opcaoMenuTexto: { color: "#F5F5F5", fontSize: 16, fontWeight: "600" },
  opcaoMenuTextoDestrutivo: { color: "#FF6B6B", fontSize: 16, fontWeight: "700" },
});
