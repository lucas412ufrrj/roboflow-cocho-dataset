/**
 * Quantidade de capturas paradas na fila local (`offlineQueue`), esperando
 * envio — inclui as com erro, que continuam contando como pendentes até
 * serem enviadas ou canceladas. Usado fora da tela de Histórico (badge no
 * cabeçalho, aviso na tela inicial) pra deixar claro que existe algo parado
 * sem precisar abrir o Histórico pra descobrir.
 */
import { useCallback, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";

import { countPending } from "@/services/offlineQueue";
import { subscribeQueueChanges } from "@/services/syncEngine";

export function usePendingCount(): number {
  const [pendentes, setPendentes] = useState(0);

  const carregar = useCallback(() => {
    countPending().then(setPendentes);
  }, []);

  useFocusEffect(
    useCallback(() => {
      carregar();
      const cancelarAssinatura = subscribeQueueChanges(carregar);
      return cancelarAssinatura;
    }, [carregar])
  );

  return pendentes;
}
