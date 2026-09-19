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
    versao: "2026-09-19",
    data: "19/09/2026",
    itens: [
      "Cada cocho cadastrado agora tem um menu (⋮) com opções de editar ou excluir.",
      "A lista de cochos agora é compartilhada entre a equipe (antes era só local a cada aparelho). Cadastrar, editar ou excluir continua restrito a quem tiver a chave de administrador configurada em Sobre.",
      "Novo campo \"Experimento/ano\" no cadastro de cocho, separado do nome, pra ajudar a comparar dados entre cochos e entre anos depois.",
      "Tela de gravação agora mostra uma marcação na tela pra ajudar a manter distância e ângulo parecidos entre pessoas e entre gravações.",
    ],
  },
  {
    versao: "2026-09-17",
    data: "17/09/2026",
    itens: [
      "Gravar vídeo agora usa a câmera do próprio app: aperte para gravar e ela para sozinha depois de alguns segundos, com uma vibração avisando que terminou — sem precisar controlar o tempo.",
    ],
  },
  {
    versao: "2026-09-14-6",
    data: "14/09/2026",
    itens: [
      "Agora é obrigatório informar seu nome ao abrir o app pela primeira vez (aparece um aviso na tela inicial). Fica salvo no aparelho e é anexado a cada captura enviada, sem precisar digitar de novo — dá pra trocar depois pelo link \"Operador(a)\" no rodapé da tela inicial.",
      "Agora o horário em que o vídeo foi gravado sobe como metadado para complementar ainda mais a pool de dados do experimento.",
      "Notificação avisando quando uma captura pendente termina de enviar, ou quando um envio está falhando repetidamente — mesmo com o app fechado.",
      "O Histórico agora mostra uma miniatura de cada vídeo, além do texto.",
      "Vídeos grandes agora são enviados em pedaços: se a conexão cair no meio do envio, a próxima tentativa continua de onde parou, em vez de reenviar tudo de novo.",
    ],
  },
  {
    versao: "2026-09-14-5",
    data: "14/09/2026",
    itens: [
      "Lobby e tela de nova captura agora mostram um aviso quando existem capturas paradas aguardando envio, sem precisar abrir o Histórico pra descobrir.",
      "Nova tela \"Sobre\" (link no rodapé da tela inicial) mostra a versão instalada, útil pra conferir rapidinho se todo mundo da equipe está atualizado.",
      "Botão \"Exportar histórico\" na aba Histórico gera um resumo em texto de todas as capturas, pra mandar por WhatsApp ou salvar.",
    ],
  },
  {
    versao: "2026-09-14-4",
    data: "14/09/2026",
    itens: [
      "Histórico agora mostra o percentual de frames aprovados ao lado da contagem (ex.: 8/9 · 89%), colorido pra ficar fácil notar de relance uma captura que rendeu pouco.",
    ],
  },
  {
    versao: "2026-09-14-3",
    data: "14/09/2026",
    itens: [
      "Tela de Prévia agora mostra peso, tipo de alimento, ID do cocho e observações com um link 'editar' em cada um — toca pra corrigir ali mesmo, sem precisar voltar pra tela de formulário.",
    ],
  },
  {
    versao: "2026-09-14-2",
    data: "14/09/2026",
    itens: [
      "Botão 'Sincronizar agora' na tela de Histórico, pra forçar o envio de tudo que estiver pendente sem esperar.",
      "Cada captura pendente agora tem um menu (⋮) com a opção de cancelar o envio — apaga o vídeo do aparelho, útil se o arquivo estiver corrompido ou travando a fila.",
    ],
  },
  {
    versao: "2026-09-14",
    data: "14/09/2026",
    itens: [
      "Nova aba de Histórico (botão no topo da tela de nova captura), mostrando data e hora de cada captura, se já foi enviada ou está aguardando sincronização, e quantos frames foram aprovados depois do envio.",
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
      "Corrigido: a tela de envio podia ficar travada numa tela preta ao abrir, por causa de uma importação errada no código (achado com o log do Android, obrigado pela paciência).",
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
