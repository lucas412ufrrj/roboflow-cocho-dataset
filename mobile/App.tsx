// Precisa ser o primeiro import: instala o handler de erro global antes de
// qualquer outro módulo (inclusive os que registram tarefas em segundo
// plano) ser carregado. Ver comentário em src/errorReporting.ts.
import "@/errorReporting";

import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import NetInfo from "@react-native-community/netinfo";

import { RootNavigator } from "@/navigation/RootNavigator";
import { sincronizarFila } from "@/services/syncEngine";
import { sincronizarCochos } from "@/services/cochoSync";
import { sincronizarTiposAlimento } from "@/services/tipoAlimentoSync";
import { listQueue } from "@/services/offlineQueue";
import { reconciliarComFila } from "@/services/historicoEnvios";
import { configurarNotificacoes } from "@/services/notifications";
// Importado pelo efeito colateral: registra a tarefa de segundo plano no
// TaskManager assim que o bundle JS carrega (inclusive quando o SO acorda o
// app só para rodar a tarefa, sem montar este componente).
import { registrarSincronizacaoEmSegundoPlano } from "@/tasks/backgroundSyncTask";
import { CHANGELOG } from "@/data/changelog";
import { marcarVersaoComoVista, obterUltimaVersaoVista } from "@/services/changelogVisto";
import { registrarAbridorDeChangelog } from "@/services/changelogControl";
import { verificarBuildDesatualizada } from "@/services/buildCheck";
import { ChangelogModal } from "@/components/ChangelogModal";
import { UpdateBanner } from "@/components/UpdateBanner";
import { AutoUpdateApplier } from "@/components/AutoUpdateApplier";
import { OutdatedBuildBanner } from "@/components/OutdatedBuildBanner";

export default function App() {
  const estadoAppAnterior = useRef<AppStateStatus>(AppState.currentState);
  const [changelogVisivel, setChangelogVisivel] = useState(false);

  useEffect(() => {
    // Registra o handler de notificação antes de qualquer sincronização
    // rodar, pra não perder o aviso de uma captura que termina de enviar
    // logo nos primeiros instantes depois de abrir o app.
    configurarNotificacoes();

    // Permite abrir a tela de novidades manualmente (botão "O que há de
    // novo?" na Lobby), além da abertura automática logo abaixo.
    registrarAbridorDeChangelog(() => setChangelogVisivel(true));

    // Cobre o caso mais comum: a equipe grava na fazenda sem sinal e só
    // reabre o app depois, já com wifi (mesmo que seja só pra ver o app, não
    // necessariamente pra gravar uma nova captura).
    sincronizarFila();
    // Sincronização velada do registro de cochos (ver `cochoSync.ts`) e do
    // registro de tipos de alimento (ver `tipoAlimentoSync.ts`) — nos mesmos
    // gatilhos de `sincronizarFila`, mas sem nenhum retorno visível.
    sincronizarCochos();
    sincronizarTiposAlimento();

    // Aviso de build nativa desatualizada (ver services/buildCheck.ts) —
    // roda nos mesmos gatilhos de `sincronizarFila` (abertura e retorno ao
    // primeiro plano), já que os dois são checagens leves e nada bloqueantes.
    verificarBuildDesatualizada();

    // Preenche qualquer captura órfã (na fila mas sem registro no Histórico)
    // logo na abertura do app, sem depender da pessoa entrar na aba
    // Histórico pra isso acontecer — ver comentário em `reconciliarComFila`.
    listQueue()
      .then((fila) => reconciliarComFila(fila))
      .catch(() => undefined);

    registrarSincronizacaoEmSegundoPlano();

    const assinaturaEstadoApp = AppState.addEventListener("change", (proximoEstado) => {
      if (estadoAppAnterior.current.match(/inactive|background/) && proximoEstado === "active") {
        sincronizarFila();
        sincronizarCochos();
        sincronizarTiposAlimento();
        verificarBuildDesatualizada();
      }
      estadoAppAnterior.current = proximoEstado;
    });

    // Cobre o app aberto (mesmo em segundo plano, ainda vivo em memória) no
    // instante em que o wifi conecta — ex.: o celular entra no alcance do
    // roteador da fazenda ou de casa.
    const cancelarAssinaturaRede = NetInfo.addEventListener((estado) => {
      if (estado.type === "wifi" && estado.isConnected) {
        sincronizarFila();
        sincronizarCochos();
        sincronizarTiposAlimento();
      }
    });

    // Mostra a tela de novidades só quando existe uma entrada de changelog
    // mais nova do que a última que a pessoa já fechou.
    (async () => {
      const versaoMaisRecente = CHANGELOG[0]?.versao;
      if (!versaoMaisRecente) return;
      const versaoVista = await obterUltimaVersaoVista();
      if (versaoVista !== versaoMaisRecente) {
        setChangelogVisivel(true);
      }
    })();

    return () => {
      assinaturaEstadoApp.remove();
      cancelarAssinaturaRede();
    };
  }, []);

  function fecharChangelog() {
    setChangelogVisivel(false);
    const versaoMaisRecente = CHANGELOG[0]?.versao;
    if (versaoMaisRecente) marcarVersaoComoVista(versaoMaisRecente);
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <RootNavigator />
      <OutdatedBuildBanner />
      <UpdateBanner />
      <AutoUpdateApplier />
      <ChangelogModal visivel={changelogVisivel} onFechar={fecharChangelog} />
    </SafeAreaProvider>
  );
}
