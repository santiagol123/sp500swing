const { resolveWorkspace, listWorkspaces, DEFAULT_WORKSPACE } = require("../lib/workspaces");
const { getSignals } = require("../lib/runtime");
const { readState } = require("../lib/store");
const { currentEquity } = require("../lib/papertrading");

// El frontend (src/utils.js mapApiRow) lee nombres de campo heredados. Las
// estrategias trabajan internamente con una forma comun, asi que aqui se
// traduce de vuelta: asi una estrategia nueva se pinta sola, sin tocar la UI.
function toLegacyRow(signal, index = 0) {
  return {
    Accion_Ejecucion: signal.action,
    Accion: signal.family,
    ticker: signal.ticker,
    name: signal.name,
    gics_sector: signal.sector,
    strategy_family: signal.family,
    rank_today: index + 1,
    last_close: signal.last_close,
    entry_zone_low: signal.entry_zone_low,
    entry_zone_high: signal.entry_zone_high,
    invalid_below_price: signal.invalid_below_price,
    target_price: signal.target_price,
    risk_reward_ratio: signal.risk_reward_ratio,
    rsi14: signal.meta?.rsi14 ?? null,
    macd_hist: signal.meta?.macd_hist ?? null,
    opt_score: signal.opt_score ?? null,
    portfolio_allowed: Boolean(signal.authorized),
    portfolio_limit_reason: signal.reason,
    tamano_entrada_pct: signal.size_pct,
    Plan_Orden: signal.plan,
    Motivo_Ejecucion: signal.reason,
    // Detalle propio de insiders; el frontend lo ignora si no lo conoce.
    insider: signal.meta?.insider_count ? signal.meta : undefined,
  };
}

function paperPortfolio(workspace) {
  const state = readState(workspace);
  return {
    equity: Number(currentEquity(state).toFixed(2)),
    initial_equity: state.initial_equity,
    open_positions: state.positions,
    closed_trades: state.trades.length,
    tracked_days: state.tracked_days,
    last_tracked_date: state.last_market_date,
  };
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url || "/api/signals", `https://${req.headers.host || "localhost"}`);
    const workspaceId = url.searchParams.get("workspace") || DEFAULT_WORKSPACE;
    const workspace = resolveWorkspace(workspaceId);

    const maxSymbols = Number(url.searchParams.get("maxSymbols") || 0);
    const concurrency = Number(url.searchParams.get("concurrency") || process.env.SCANNER_CONCURRENCY || 24);

    const result = await getSignals(workspace, { maxSymbols, concurrency });

    // Momentum devuelve el payload completo del scanner: se respeta tal cual
    // para no romper el contrato que ya consume el frontend (cartera real,
    // regimen de mercado, top_ranked...).
    const base = result.payload || {};
    const isMomentum = Boolean(result.payload);

    const recommendations = isMomentum
      ? base.recommendations || []
      : result.signals.filter((s) => s.authorized).map(toLegacyRow);
    const technicalEntries = isMomentum
      ? base.technical_entries || []
      : result.signals.filter((s) => s.action === "COMPRAR_LIMITADA" || s.authorized).map(toLegacyRow);
    const watch = isMomentum
      ? base.watch || []
      : result.signals.filter((s) => !s.authorized).map(toLegacyRow).slice(0, 20);

    const payload = {
      ok: true,
      generated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,

      // --- selector de workspace ---
      workspace: {
        id: workspace.id,
        label: workspace.label,
        description: workspace.description,
        live: workspace.live,
        source: result.source,
        computed_at: result.computed_at,
      },
      workspaces: listWorkspaces(),
      warning: result.warning || null,

      // --- contrato heredado que consume src/utils.js ---
      universe_source: base.universe_source ?? result.diagnostics?.universe_source ?? null,
      universe_count: base.universe_count ?? result.diagnostics?.universe_count ?? null,
      downloaded_count: base.downloaded_count ?? null,
      failed_count: base.failed_count ?? result.diagnostics?.price_download_failed ?? 0,
      failed: base.failed || [],
      latest_market_date: base.latest_market_date ?? result.market_date ?? null,
      market_regime: base.market_regime ?? null,
      dashboard: base.dashboard ?? result.diagnostics ?? {},
      recommendations,
      technical_entries: technicalEntries,
      watch,
      top_ranked: base.top_ranked || [],
      rules: base.rules ?? result.extra?.rules ?? null,
      // Cartera REAL (data/portfolio.json). Solo la calcula momentum.
      portfolio: base.portfolio ?? null,

      // Cartera simulada de este workspace, que alimenta el ranking.
      // Va en una clave aparte para no pisar la cartera real de arriba.
      paper_portfolio: paperPortfolio(workspace),
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.statusCode = 200;
    res.end(JSON.stringify(payload, null, 2));
  } catch (error) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.statusCode = 500;
    res.end(
      JSON.stringify(
        {
          ok: false,
          error: error.message,
          elapsed_ms: Date.now() - startedAt,
          generated_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }
};
