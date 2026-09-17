import { useCallback, useState } from "react";
import { Alert, FlatList, Image, Modal, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { listarHistorico, reconciliarComFila, type HistoricoEntry } from "@/services/historicoEnvios";
import { listQueue, type QueueItem } from "@/services/offlineQueue";
import {
  cancelarCaptura,
  estaEnviandoAgora,
  sincronizarFila,
  subscribeProcessando,
  subscribeProgress,
  subscribeQueueChanges,
} from "@/services/syncEngine";
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

/**
 * Badge de uma linha "aguardando sincronização" pode significar três coisas
 * bem diferentes na prática — só o Histórico sabe qual, cruzando com o item
 * correspondente na fila local (`offlineQueue`), que o status genérico do
 * Histórico não distingue: enviando agora mesmo, já tentou e falhou (com o
 * motivo real do `lastError`), ou só esperando a vez/wifi.
 */
function badgeDaLinha(
  item: HistoricoEntry,
  itemNaFila: QueueItem | undefined
): { texto: string; cor: string; fundo: string } {
  if (item.status === "aguardando_sincronizacao") {
    if (itemNaFila?.status === "enviando") {
      return { texto: "Enviando agora", cor: "#3D8BFD", fundo: "#3D8BFD22" };
    }
    if (itemNaFila?.status === "erro") {
      const vezes = itemNaFila.attempts ? ` (${itemNaFila.attempts}x)` : "";
      return { texto: `Falha no envio${vezes}`, cor: "#FF6B6B", fundo: "#FF6B6B22" };
    }
  }
  return STATUS_INFO[item.status];
}

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

function Linha({
  item,
  itemNaFila,
  progresso,
  processando,
  onAbrirMenu,
}: {
  item: HistoricoEntry;
  itemNaFila: QueueItem | undefined;
  progresso: number | undefined;
  processando: boolean;
  onAbrirMenu: (item: HistoricoEntry) => void;
}) {
  const info = badgeDaLinha(item, itemNaFila);
  const enviandoAgora = item.status === "aguardando_sincronizacao" && itemNaFila?.status === "enviando";
  const comFalha =
    item.status === "aguardando_sincronizacao" && itemNaFila?.status === "erro" && !!itemNaFila.lastError;
  // Não deixa cancelar um vídeo que está sendo enviado neste exato instante —
  // `cancelarCaptura` já recusa nesse caso, mas esconder o menu evita o
  // toque em vão e deixa mais claro que algo está de fato acontecendo.
  const podeCancelar = item.status === "aguardando_sincronizacao" && !enviandoAgora;
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

        {enviandoAgora && processando && (
          // Bytes já foram todos enviados — o backend está reassemblando,
          // extraindo frames e validando o cocho, o que pode demorar bem
          // mais que o envio em si. Sem isso, a barra ficaria parada em
          // ~100% por vários minutos e pareceria travada.
          <View style={styles.progressoLinha}>
            <Text style={styles.progressoLinhaTextoProcessando}>Processando no servidor</Text>
            <AnimatedDots color="#3D8BFD" size={4} />
          </View>
        )}

        {enviandoAgora && !processando && (
          <View style={styles.progressoLinha}>
            <View style={styles.progressoLinhaFundo}>
              <View
                style={[styles.progressoLinhaPreenchida, { width: `${Math.round((progresso ?? 0) * 100)}%` }]}
              />
            </View>
            <Text style={styles.progressoLinhaTexto}>{Math.round((progresso ?? 0) * 100)}%</Text>
          </View>
        )}

        {comFalha && (
          <Text style={styles.falhaTexto} numberOfLines={2}>
            {itemNaFila?.lastError}
          </Text>
        )}

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
  const insets = useSafeAreaInsets();
  const [historico, setHistorico] = useState<HistoricoEntry[]>([]);
  // Espelha a fila local (offlineQueue) por captureId — é o que permite
  // distinguir, pra cada linha "aguardando sincronização", entre "enviando
  // agora", "já tentou e falhou (com o motivo real)" e "só esperando a vez",
  // coisa que o status do Histórico sozinho não guarda.
  const [filaPorId, setFilaPorId] = useState<Record<string, QueueItem>>({});
  const [progressoPorId, setProgressoPorId] = useState<Record<string, number>>({});
  const [processandoPorId, setProcessandoPorId] = useState<Record<string, boolean>>({});
  const [sincronizando, setSincronizando] = useState(false);
  const [itemDoMenu, setItemDoMenu] = useState<HistoricoEntry | null>(null);
  const [cancelando, setCancelando] = useState(false);

  const carregar = useCallback(() => {
    // Antes de listar, preenche qualquer captura que esteja na fila local mas
    // não tenha registro no Histórico — ver comentário em
    // `reconciliarComFila`. Sem isso, uma captura pode contar como pendente
    // em outros cantos do app (ex.: badge da Lobby) sem nunca aparecer aqui.
    listQueue()
      .then((fila) => {
        const porId: Record<string, QueueItem> = {};
        for (const item of fila) porId[item.captureId] = item;
        setFilaPorId(porId);
        return reconciliarComFila(fila);
      })
      .then(() => listarHistorico())
      .then(setHistorico);
  }, []);

  useFocusEffect(
    useCallback(() => {
      carregar();
      const cancelarAssinatura = subscribeQueueChanges(carregar);
      // Progresso é um canal à parte, bem mais frequente — atualiza só um
      // mapa local em memória, sem recarregar a lista inteira do disco a
      // cada pedacinho enviado (ver comentário em `subscribeProgress`).
      const cancelarProgresso = subscribeProgress((captureId, fracao) => {
        setProgressoPorId((atual) => ({ ...atual, [captureId]: fracao }));
      });
      const cancelarProcessando = subscribeProcessando((captureId, processando) => {
        setProcessandoPorId((atual) => ({ ...atual, [captureId]: processando }));
      });
      return () => {
        cancelarAssinatura();
        cancelarProgresso();
        cancelarProcessando();
      };
    }, [carregar])
  );

  const pendentes = historico.filter((item) => item.status === "aguardando_sincronizacao").length;
  // Verdade em tempo real, não só depois de tocar no botão: se algum vídeo já
  // está subindo agora (gatilho automático ou manual, não importa), o botão
  // reflete isso ANTES da pessoa tocar — em vez de convidar a um toque que só
  // vai resultar em "nada enviado" porque o envio de verdade já está rolando.
  const enviandoAgoraAlgumItem = Object.keys(filaPorId).some((captureId) => estaEnviandoAgora(captureId));

  async function sincronizarAgora() {
    setSincronizando(true);
    try {
      const resultado = await sincronizarFila();
      if (resultado.jaEmAndamento) {
        Alert.alert(
          "Já está sincronizando",
          "Uma sincronização automática já está em andamento (por exemplo, ao conectar no wifi). Acompanhe o progresso na lista abaixo — é por isso que este toque não teve o que fazer."
        );
      } else if (resultado.semWifi) {
        Alert.alert(
          "Sem wifi",
          "Não achei uma rede wifi conectada agora (dados móveis não contam). Conecte no wifi e tente de novo."
        );
      } else if (resultado.enviados === 0) {
        if (resultado.totalPendentes === 0) {
          Alert.alert("Nada pendente", "Não há capturas aguardando envio.");
        } else if (resultado.itensJaEmEnvio === resultado.totalPendentes) {
          // Nenhum destes pendentes estava livre pra tentar — todos já
          // estavam sendo enviados por outro gatilho (ex.: "Tentar
          // novamente agora" da tela de Envio rodando ao mesmo tempo).
          Alert.alert(
            "Já está enviando",
            `${
              resultado.itensJaEmEnvio === 1
                ? "O vídeo pendente já está"
                : `Os ${resultado.itensJaEmEnvio} vídeos pendentes já estão`
            } sendo enviados agora por outra tela ou gatilho automático. Acompanhe o progresso na lista abaixo.`
          );
        } else if (resultado.falhas.length > 0) {
          const [primeira, ...outras] = resultado.falhas;
          const extra =
            outras.length > 0
              ? `\n\n+ ${outras.length} outra${outras.length > 1 ? "s" : ""} captura${
                  outras.length > 1 ? "s" : ""
                } com falha — veja o motivo de cada uma na própria lista.`
              : "";
          Alert.alert("Não deu pra enviar agora", `${primeira.motivo}${extra}`);
        } else {
          // Situação residual e rara: nenhum pendente foi enviado, mas
          // nenhum dos motivos específicos acima se aplica (ex.: outro
          // gatilho pegou um item bem no instante entre a checagem e a
          // tentativa). Não inventa um motivo que não conseguiu confirmar.
          Alert.alert(
            "Não deu pra confirmar o motivo",
            "Nenhuma captura foi enviada agora, mas não consegui identificar uma causa específica — pode ter sido uma corrida com outro envio em andamento. Os vídeos continuam salvos; toque em \"Sincronizar agora\" de novo em alguns segundos."
          );
        }
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
          style={[
            styles.botaoSincronizar,
            (sincronizando || enviandoAgoraAlgumItem || pendentes === 0) && styles.botaoSincronizarDesabilitado,
          ]}
          onPress={sincronizarAgora}
          disabled={sincronizando || enviandoAgoraAlgumItem || pendentes === 0}
        >
          {sincronizando || enviandoAgoraAlgumItem ? (
            <View style={styles.linhaSincronizando}>
              <Text style={styles.botaoSincronizarTexto}>
                {enviandoAgoraAlgumItem && !sincronizando ? "Já enviando" : "Sincronizando"}
              </Text>
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
        contentContainerStyle={
          historico.length === 0
            ? styles.listaVaziaContainer
            : [styles.listaContainer, { paddingBottom: 20 + insets.bottom }]
        }
        data={historico}
        keyExtractor={(item) => item.captureId}
        renderItem={({ item }) => (
          <Linha
            item={item}
            itemNaFila={filaPorId[item.captureId]}
            progresso={progressoPorId[item.captureId]}
            processando={processandoPorId[item.captureId] ?? false}
            onAbrirMenu={setItemDoMenu}
          />
        )}
        extraData={[filaPorId, progressoPorId, processandoPorId]}
        ListEmptyComponent={
          <View style={styles.vazio}>
            <Text style={styles.vazioTexto}>Nenhuma captura registrada ainda.</Text>
          </View>
        }
      />

      <Modal visible={itemDoMenu !== null} transparent animationType="fade" onRequestClose={() => setItemDoMenu(null)}>
        <Pressable style={styles.overlay} onPress={() => setItemDoMenu(null)}>
          <View style={[styles.folhaMenu, { paddingBottom: 32 + insets.bottom }]}>
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
  progressoLinha: { flexDirection: "row", alignItems: "center", gap: 8 },
  progressoLinhaFundo: {
    flex: 1,
    height: 6,
    borderRadius: 4,
    backgroundColor: "#1B2530",
    overflow: "hidden",
  },
  progressoLinhaPreenchida: { height: 6, backgroundColor: "#3D8BFD" },
  progressoLinhaTexto: { color: "#8A8F98", fontSize: 11, fontWeight: "700", minWidth: 32, textAlign: "right" },
  progressoLinhaTextoProcessando: { color: "#3D8BFD", fontSize: 12, fontWeight: "700" },
  falhaTexto: { color: "#FF6B6B", fontSize: 12 },
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
