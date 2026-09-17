/**
 * Histórico de novidades mostrado na tela de changelog ao abrir o app.
 *
 * Manutenção: sempre que uma atualização for enviada (`eas update`), some
 * uma entrada nova no TOPO deste array, com uma `versao` diferente da
 * anterior. A tela de changelog só reaparece automaticamente quando a
 * `versao` mais recente aqui é diferente da última que a pessoa já fechou
 * (ver `src/services/changelogVisto.ts`).
 */
export interface ChangelogEntry {
  /** Identificador único desta entrada (ex.: a data). Não precisa ser bonito. */
  versao: string;
  data: string;
  itens: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    versao: "2026-09-17",
    data: "17/09/2026",
    itens: [
      "Gravar vídeo agora usa a câmera do próprio app: aperte para gravar e ela para sozinha depois de alguns segundos, com uma vibração avisando que terminou.",
    ],
  },
  {
    versao: "2026-09-14-6",
    data: "14/09/2026",
    itens: [
      "Agora é obrigatório informar seu nome ao abrir o app pela primeira vez.",
      "Agora o horário em que o vídeo foi gravado sobe como metadado para complementar ainda mais a pool de dados do experimento.",
      "Notificação avisando quando uma captura pendente termina de enviar, ou quando um envio está falhando repetidamente.",
      "O Histórico agora mostra uma miniatura de cada vídeo, além do texto.",
      "Vídeos grandes agora são enviados em pedaços: se a conexão cair no meio do envio, a próxima tentativa continua de onde parou.",
    ],
  },
  {
    versao: "2026-09-14-5",
    data: "14/09/2026",
    itens: [
      "Lobby e tela de nova captura agora mostram um aviso quando existem capturas paradas aguardando envio.",
      "Nova tela \"Sobre\" (link no rodapé da tela inicial) mostra a versão instalada.",
      "Botão \"Exportar histórico\" na aba Histórico gera um resumo em texto.",
    ],
  },
  {
    versao: "2026-09-14-4",
    data: "14/09/2026",
    itens: [
      "Histórico agora mostra o percentual de frames aprovados ao lado da contagem (ex.: 8/9 · 89%).",
    ],
  },
  {
    versao: "2026-09-14-3",
    data: "14/09/2026",
    itens: [
      "Tela de Prévia agora mostra peso, tipo de alimento, ID do cocho e observações com possibilidade de alteração antes de enviar.",
    ],
  },
  {
    versao: "2026-09-14-2",
    data: "14/09/2026",
    itens: [
      "Botão 'Sincronizar agora' na tela de Histórico, pra forçar o envio de tudo que estiver pendente sem esperar.",
      "Cada captura pendente agora tem um menu (⋮) com a opção de cancelar o envio.",
    ],
  },
  {
    versao: "2026-09-14",
    data: "14/09/2026",
    itens: [
      "Nova aba de Histórico, mostrando data e hora de cada captura, se já foi enviada ou está aguardando sincronização, e quantos frames foram aprovados depois do envio.",
    ],
  },
  {
    versao: "2026-09-10-10",
    data: "10/09/2026",
    itens: ["Melhorias no design da tela de lobby (logo, botões e layout)."],
  },
  {
    versao: "2026-09-10-4",
    data: "10/09/2026",
    itens: [
      "Corrigido: a barra de progresso do envio podia passar de 100%.",
      "A tela de envio agora mostra pontinhos animados enquanto o vídeo está sendo enviado ou processado, pra ficar claro que não travou.",
      "O aviso de atualização baixando também ganhou os pontinhos animados.",
    ],
  },
  {
    versao: "2026-09-10-2",
    data: "10/09/2026",
    itens: [
      "Corrigido: a tela de envio podia ficar travada numa tela preta ao abrir, por causa de uma importação errada no código.",
    ],
  },
  {
    versao: "2026-09-10",
    data: "10/09/2026",
    itens: [
      "Capturas agora ficam salvas no aparelho assim que confirmadas e são enviadas sozinhas quando o wifi conectar, mesmo com o app fechado.",
      "Se um erro grave acontecer, o app agora mostra uma mensagem explicando o que houve em vez de ficar com a tela travada sem explicação.",
      "Aviso de atualização baixando/pronta para aplicar, e esta tela de novidades.",
    ],
  },
];
