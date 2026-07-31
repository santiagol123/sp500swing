// Registro de estrategias. Anadir una tercera es crear el modulo con la misma
// interfaz ({ id, label, run }) y registrarlo aqui.

const momentum = require("./momentum");
const insider = require("./insider");

const STRATEGIES = {
  [momentum.id]: momentum,
  [insider.id]: insider,
};

function getStrategy(id) {
  const strategy = STRATEGIES[String(id || "").toLowerCase().trim()];
  if (!strategy) {
    throw new Error(`Estrategia desconocida: "${id}". Disponibles: ${Object.keys(STRATEGIES).join(", ")}`);
  }
  return strategy;
}

module.exports = { STRATEGIES, getStrategy };
