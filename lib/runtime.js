// Puente entre las estrategias y la capa HTTP.
//
// Los workspaces "live" se calculan en cada peticion. Los que no lo son
// (insider, limitado por el rate limit de la SEC) se sirven desde el ultimo
// snapshot que dejo el GitHub Action.

const { getStrategy } = require("./strategies");
const { readJson } = require("./store");

async function runStrategy(workspace, options = {}) {
  const strategy = getStrategy(workspace.strategy);
  return strategy.run(options);
}

function loadSnapshot(workspace) {
  return readJson(workspace.id, "signals", null);
}

// Devuelve las senales del workspace listas para la API, indicando siempre
// de donde salen y cuando se calcularon.
async function getSignals(workspace, options = {}) {
  if (workspace.live) {
    const result = await runStrategy(workspace, options);
    return {
      source: "live",
      computed_at: new Date().toISOString(),
      market_date: result.market_date,
      signals: result.signals,
      watch: result.watch || [],
      diagnostics: result.diagnostics,
      extra: result.extra || {},
      // Solo momentum lo trae: es el payload heredado completo del scanner.
      payload: result.payload,
    };
  }

  const snapshot = loadSnapshot(workspace);
  if (!snapshot) {
    return {
      source: "snapshot",
      computed_at: null,
      market_date: null,
      signals: [],
      watch: [],
      diagnostics: {},
      extra: {},
      warning:
        "Todavia no hay snapshot. Los workspaces de insiders los genera el GitHub Action (no caben en una funcion de 60s por el limite de la SEC). Ejecuta `npm run track` para generarlo.",
    };
  }

  return {
    source: "snapshot",
    computed_at: snapshot.computed_at || null,
    market_date: snapshot.market_date || null,
    signals: snapshot.signals || [],
    watch: snapshot.watch || [],
    diagnostics: snapshot.diagnostics || {},
    extra: snapshot.extra || {},
  };
}

module.exports = { runStrategy, loadSnapshot, getSignals };
