// Registro de estrategias. Anadir una tercera es crear el modulo con la misma
// interfaz ({ id, label, run }) y registrarlo aqui.

const momentum = require("./momentum");
const insider = require("./insider");
const insiderTotal = require("./insider_total");
const chatgptSp500 = require("./chatgpt_sp500");
const chatgptSp500Nasdaq = require("./chatgpt_sp500_nasdaq");

const STRATEGIES = {
  [momentum.id]: momentum,
  [insider.id]: insider,
  [insiderTotal.id]: insiderTotal,
  [chatgptSp500.id]: chatgptSp500,
  [chatgptSp500Nasdaq.id]: chatgptSp500Nasdaq,
};

function getStrategy(id) {
  const strategy = STRATEGIES[String(id || "").toLowerCase().trim()];
  if (!strategy) {
    throw new Error(`Estrategia desconocida: "${id}". Disponibles: ${Object.keys(STRATEGIES).join(", ")}`);
  }
  return strategy;
}

module.exports = { STRATEGIES, getStrategy };
