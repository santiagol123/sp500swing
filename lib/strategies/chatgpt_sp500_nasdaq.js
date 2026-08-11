// Variante de la estrategia ChatGPT: mismo filtro de conviccion y salida a 5
// sesiones, pero con universo S&P 500 + Nasdaq-100.

const chatgptSp500 = require("./chatgpt_sp500");
const { loadSp500Nasdaq100Universe } = require("../universe");

const PROFILE = {
  strategyId: "chatgpt_sp500_nasdaq",
  convictionLabel: "S&P 500 + Nasdaq-100",
  benchmark: "QQQ",
  executionProfile: "chatgpt_sp500_nasdaq_insider_conviction",
  ruleSource: "chat_pasted_text_insider_conviction_sp500_nasdaq100",
};

async function run(options = {}) {
  return chatgptSp500.run({
    ...options,
    universeLoader: loadSp500Nasdaq100Universe,
    profile: PROFILE,
  });
}

module.exports = {
  id: "chatgpt_sp500_nasdaq",
  label: "Insiders SP500+Nasdaq",
  description:
    "Compras fuertes de insiders del S&P 500 y Nasdaq-100: Form 4 codigo P/Dataroma, conviccion senior, importe material y salida temporal a 5 sesiones.",
  signal_source: "SEC EDGAR + Dataroma + Yahoo Finance",
  run,
};
