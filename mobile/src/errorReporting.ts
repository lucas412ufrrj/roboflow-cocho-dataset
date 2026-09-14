/**
 * Rede de segurança pra parar de "adivinhar" o que está travando o app numa
 * tela preta/cinza. Isso intercepta QUALQUER erro fatal do JavaScript
 * (inclusive um erro lançado durante o carregamento de um módulo, antes de
 * qualquer tela renderizar) e mostra a mensagem num Alert nativo, que não
 * depende do React ter conseguido desenhar algo na tela.
 *
 * Importante: isso precisa ser a PRIMEIRA coisa importada em App.tsx, antes
 * de qualquer outro import — assim o handler já está instalado quando os
 * módulos seguintes (que registram tarefas em segundo plano, etc.) são
 * carregados.
 */
import { Alert } from "react-native";

// @ts-expect-error ErrorUtils é um global do React Native, sem tipos oficiais
const manipuladorOriginal = global.ErrorUtils?.getGlobalHandler?.();

// @ts-expect-error idem
global.ErrorUtils?.setGlobalHandler?.((erro: Error, ehFatal?: boolean) => {
  try {
    Alert.alert(
      ehFatal ? "Erro fatal no app" : "Erro no app",
      `${erro?.name ?? "Erro"}: ${erro?.message ?? "sem mensagem"}\n\n${(erro?.stack ?? "").slice(0, 600)}`
    );
  } catch {
    // Se nem o Alert conseguir abrir, não tem mais nada a fazer por aqui.
  }
  manipuladorOriginal?.(erro, ehFatal);
});
