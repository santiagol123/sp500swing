// Variante de la estrategia ChatGPT: mismo filtro de conviccion y salida a 5
// sesiones, pero con universo S&P 500 + Nasdaq-100 + NYSE.

const chatgptSp500 = require("./chatgpt_sp500");
const { loadSp500NasdaqNyseUniverse } = require("../universe");

const PROFILE = {
  strategyId: "chatgpt_sp500_nasdaq",
  convictionLabel: "S&P 500 + Nasdaq-100 + NYSE",
  benchmark: "QQQ",
  executionProfile: "chatgpt_sp500_nasdaq_nyse_insider_conviction",
  ruleSource: "chat_pasted_text_insider_conviction_sp500_nasdaq100_nyse",
  maxAuthorizedBuys: Number(process.env.CHATGPT_SP500_NASDAQ_MAX_AUTHORIZED_BUYS || 6),
  minTotalValueUsd: Number(process.env.CHATGPT_SP500_NASDAQ_MIN_VALUE_USD || 500000),
};

async function run(options = {}) {
  return chatgptSp500.run({
    ...options,
    universeLoader: loadSp500NasdaqNyseUniverse,
    profile: PROFILE,
  });
}

module.exports = {
  id: "chatgpt_sp500_nasdaq",
  label: "Insiders SP500+Nasdaq+NYSE",
  description:
    "Compras fuertes de insiders del S&P 500, Nasdaq-100 y NYSE: Form 4 codigo P/Dataroma, conviccion senior, filtros tecnicos de riesgo y salida temporal a 5 sesiones.",
  signal_source: "SEC EDGAR + Dataroma + Yahoo Finance",
  run,
};
