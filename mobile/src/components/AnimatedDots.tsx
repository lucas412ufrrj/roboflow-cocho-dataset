import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";

/**
 * Três pontinhos que pulsam em sequência, tipo indicador de "processando" /
 * "digitando". Usado em qualquer lugar que precise deixar claro que algo
 * ainda está rodando em segundo plano (envio, download de atualização) e
 * não travou, mesmo sem um número de progresso pra mostrar.
 */
export function AnimatedDots({ color = "#B5B9C0", size = 6 }: { color?: string; size?: number }) {
  const valores = useRef([new Animated.Value(0.3), new Animated.Value(0.3), new Animated.Value(0.3)]).current;

  useEffect(() => {
    const animacoes = valores.map((valor, indice) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(indice * 180),
          Animated.timing(valor, { toValue: 1, duration: 320, useNativeDriver: true }),
          Animated.timing(valor, { toValue: 0.3, duration: 320, useNativeDriver: true }),
          Animated.delay((2 - indice) * 180),
        ])
      )
    );
    animacoes.forEach((animacao) => animacao.start());
    return () => animacoes.forEach((animacao) => animacao.stop());
  }, [valores]);

  return (
    <View style={styles.linha}>
      {valores.map((valor, indice) => (
        <Animated.View
          key={indice}
          style={[
            styles.ponto,
            {
              backgroundColor: color,
              width: size,
              height: size,
              borderRadius: size / 2,
              opacity: valor,
              transform: [
                {
                  scale: valor.interpolate({ inputRange: [0.3, 1], outputRange: [0.8, 1.15] }),
                },
              ],
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  linha: { flexDirection: "row", gap: 5, alignItems: "center" },
  ponto: {},
});
