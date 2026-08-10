// Estrategia 3: orden programada ChatGPT S&P 500.
//
// Reutiliza el scanner tecnico S&P 500 que ya alimenta Momentum, pero lo
// expone como una estrategia separada para llevar una cartera paper propia.

const momentum = require("./momentum");

function retagSignal(signal) {
  return {
    ...signal,
    strategy: "chatgpt_sp500",
  };
}

async function run(options = {}) {
  const result = await momentum.run(options);

  return {
    ...result,
    signals: (result.signals || []).map(retagSignal),
    watch: (result.watch || []).map(retagSignal),
    diagnostics: {
      ...(result.diagnostics || {}),
      source_strategy: "momentum",
      execution_profile: "chatgpt_sp500_scheduled_order",
    },
    extra: {
      ...(result.extra || {}),
      rules: {
        ...(result.extra?.rules || {}),
        note:
          "Replica la orden programada original del S&P 500 usando el scanner tecnico actual; cartera y ranking independientes.",
      },
    },
  };
}

module.exports = {
  id: "chatgpt_sp500",
  label: "Orden ChatGPT S&P 500",
  description:
    "Replica de la orden programada del S&P 500: ranking tecnico, pullbacks, rupturas, filtro de mercado y gestion automatica de cartera.",
  signal_source: "Yahoo Finance chart API",
  run,
};
