// Estrategia 1: momentum tecnico (la original del repo).
// Adapta la salida de lib/scanner.js a la forma de senal comun que consume
// el motor de paper trading, sin tocar las reglas.

const { runScanner } = require("../scanner");

function toSignal(row) {
  return {
    ticker: row.ticker,
    name: row.name,
    sector: row.gics_sector || "",
    strategy: "momentum",
    family: row.strategy_family,
    action: row.Accion_Ejecucion,
    reason: row.Motivo_Ejecucion || row.portfolio_limit_reason || "",
    plan: row.Plan_Orden || "",
    last_close: row.last_close,
    entry_zone_low: row.entry_zone_low,
    entry_zone_high: row.entry_zone_high,
    invalid_below_price: row.invalid_below_price,
    target_price: row.target_price,
    risk_reward_ratio: row.risk_reward_ratio,
    size_pct: row.tamano_entrada_pct,
    authorized: Boolean(row.portfolio_allowed),
    meta: {
      rank_today: row.rank_today,
      rsi14: row.rsi14,
      macd_hist: row.macd_hist,
      macd_hist_slope: row.macd_hist_slope,
    },
  };
}

async function run(options = {}) {
  const payload = await runScanner(options);

  // `recommendations` ya viene filtrado a portfolio_allowed; `technical_entries`
  // incluye las validas tecnicamente pero bloqueadas por limites de cartera.
  const signals = payload.technical_entries.map(toSignal);
  const watch = payload.watch.map(toSignal);

  return {
    signals,
    watch,
    charts: payload.charts,
    // El payload completo del scanner viaja intacto: la API lo reenvia tal cual
    // para no romper el contrato que ya consume el frontend (cartera real,
    // regimen de mercado, top_ranked, reglas...).
    payload,
    market_date: payload.latest_market_date,
    diagnostics: {
      universe_source: payload.universe_source,
      universe_count: payload.universe_count,
      downloaded_count: payload.downloaded_count,
      failed_count: payload.failed_count,
      failed: payload.failed,
      ...payload.dashboard,
    },
    extra: {
      top_ranked: payload.top_ranked,
      rules: payload.rules,
    },
  };
}

module.exports = {
  id: "momentum",
  label: "Momentum tecnico",
  description:
    "Reglas CORE_PULLBACK, BREAKOUT_CONTINUATION y LEADER_CONTINUATION sobre ranking transversal del S&P 500 (momentum, fuerza relativa, volumen, RSI y MACD).",
  signal_source: "Yahoo Finance chart API",
  run,
  toSignal,
};
