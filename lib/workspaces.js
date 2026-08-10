// Definicion de workspaces. Un workspace = una estrategia + su cartera de
// paper trading aislada.
//
// IMPORTANTE: las reglas de cartera son IDENTICAS para todos los workspaces.
// Si una estrategia pudiera arriesgar mas por operacion o llevar mas posiciones
// abiertas, el ranking mediria el tamano de la apuesta y no la calidad de la
// senal. Lo unico que cambia entre workspaces es que acciones se eligen.
const SHARED_PORTFOLIO = {
  initial_equity: 100000,
  max_open_positions: 12,
  max_new_positions_per_day: 3,
  max_positions_per_sector: 2,
  max_hold_days: 60,
};

const CHATGPT_SP500_PORTFOLIO = {
  ...SHARED_PORTFOLIO,
  max_hold_days: Number(process.env.CHATGPT_SP500_MAX_HOLD_DAYS || 5),
};

const WORKSPACES = {
  momentum: {
    id: "momentum",
    label: "Momentum tecnico",
    short: "Momentum",
    description:
      "Ranking transversal del S&P 500 por momentum, fuerza relativa y volumen. Entra en pullbacks dentro de tendencia y en continuaciones de ruptura.",
    strategy: "momentum",
    // Se calcula en vivo: ~500 descargas de Yahoo en paralelo caben en 60s.
    live: true,
    portfolio: SHARED_PORTFOLIO,
  },
  insider: {
    id: "insider",
    label: "Compras de directivos",
    short: "Insiders",
    description:
      "Compras en mercado abierto (formulario 4, codigo P) de directivos y consejeros. Solo dispara cuando varios insiders distintos compran la misma empresa en una ventana corta.",
    strategy: "insider",
    // NO se puede calcular en vivo: la SEC limita a 10 peticiones/segundo y
    // recorrer el S&P 500 son ~500 peticiones (>60s, el limite de la funcion).
    // Lo calcula el GitHub Action y la API sirve el ultimo snapshot.
    live: false,
    portfolio: SHARED_PORTFOLIO,
  },
  insider_total: {
    id: "insider_total",
    label: "ChatGPT SP500",
    short: "ChatGPT SP500",
    description:
      "Compras fuertes de insiders del S&P 500: Form 4 codigo P/Dataroma, clusters, directivos senior, importe material y salida temporal a 5 sesiones.",
    strategy: "chatgpt_sp500",
    // Reutiliza SEC EDGAR y Dataroma: lo calcula el GitHub Action y la API
    // sirve snapshot, igual que insiders.
    live: false,
    portfolio: CHATGPT_SP500_PORTFOLIO,
  },
};

const DEFAULT_WORKSPACE = "momentum";

function listWorkspaces() {
  return Object.values(WORKSPACES).map((w) => ({
    id: w.id,
    label: w.label,
    short: w.short,
    description: w.description,
    live: w.live,
  }));
}

function resolveWorkspace(id) {
  const key = String(id || DEFAULT_WORKSPACE).toLowerCase().trim();
  const workspace = WORKSPACES[key];
  if (!workspace) {
    throw new Error(`Workspace desconocido: "${id}". Disponibles: ${Object.keys(WORKSPACES).join(", ")}`);
  }
  return workspace;
}

module.exports = {
  WORKSPACES,
  DEFAULT_WORKSPACE,
  SHARED_PORTFOLIO,
  CHATGPT_SP500_PORTFOLIO,
  listWorkspaces,
  resolveWorkspace,
};
