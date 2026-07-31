// Metricas de rendimiento y ranking entre workspaces.

// Ojo: ./portfolio.js es la cartera REAL (data/portfolio.json). El simulador
// de paper trading, que es lo que se mide aqui, vive en ./papertrading.js.
const { currentEquity } = require("./papertrading");

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

// Con pocas operaciones cerradas cualquier ranking es ruido. Se etiqueta
// explicitamente para que la pantalla no presente como conclusion algo que
// todavia no lo es.
function confidenceLabel(closedTrades) {
  if (closedTrades < 10) return { level: "insuficiente", note: "Muestra demasiado pequena para concluir nada" };
  if (closedTrades < 30) return { level: "baja", note: "Tendencia inicial, todavia dominada por el azar" };
  if (closedTrades < 100) return { level: "media", note: "Empieza a ser informativo" };
  return { level: "alta", note: "Muestra suficiente para comparar" };
}

function maxDrawdown(equityCurve) {
  if (!equityCurve?.length) return { pct: 0, peak_date: null, trough_date: null };
  let peak = equityCurve[0].equity;
  let peakDate = equityCurve[0].date;
  let worst = 0;
  let worstPeakDate = peakDate;
  let worstTroughDate = peakDate;

  for (const point of equityCurve) {
    if (point.equity > peak) {
      peak = point.equity;
      peakDate = point.date;
    }
    const dd = peak > 0 ? point.equity / peak - 1 : 0;
    if (dd < worst) {
      worst = dd;
      worstPeakDate = peakDate;
      worstTroughDate = point.date;
    }
  }
  return { pct: round(worst, 6), peak_date: worstPeakDate, trough_date: worstTroughDate };
}

function computeMetrics(workspace, state) {
  const trades = state.trades || [];
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const equity = currentEquity(state);
  const initial = state.initial_equity || workspace.portfolio.initial_equity;

  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const rValues = trades.map((t) => t.r_multiple).filter((r) => Number.isFinite(r));
  const realizedPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const unrealizedPnl = (state.positions || []).reduce((sum, p) => sum + (p.unrealized_pnl || 0), 0);

  const dd = maxDrawdown(state.equity_curve || []);
  const confidence = confidenceLabel(trades.length);

  return {
    workspace: workspace.id,
    label: workspace.label,
    short: workspace.short,
    description: workspace.description,

    tracked_days: state.tracked_days || 0,
    first_tracked_date: state.equity_curve?.[0]?.date || null,
    last_tracked_date: state.last_market_date || null,

    initial_equity: round(initial, 2),
    equity: round(equity, 2),
    cash: round(state.cash, 2),
    total_return_pct: round(initial > 0 ? equity / initial - 1 : 0, 6),
    realized_pnl: round(realizedPnl, 2),
    unrealized_pnl: round(unrealizedPnl, 2),

    closed_trades: trades.length,
    open_positions: (state.positions || []).length,
    wins: wins.length,
    losses: losses.length,
    win_rate: trades.length ? round(wins.length / trades.length, 4) : null,

    avg_r: rValues.length ? round(rValues.reduce((a, b) => a + b, 0) / rValues.length, 3) : null,
    // Expectancy en euros por operacion: lo que deja de media cada trade.
    expectancy: trades.length ? round(realizedPnl / trades.length, 2) : null,
    // Sin operaciones no hay profit factor; y si no hay perdidas todavia, el
    // cociente seria infinito. En ambos casos null (la UI pinta "-").
    profit_factor: !trades.length || grossLoss === 0 ? null : round(grossProfit / grossLoss, 3),
    avg_hold_days: trades.length ? round(trades.reduce((sum, t) => sum + (t.hold_days || 0), 0) / trades.length, 1) : null,

    max_drawdown_pct: dd.pct,
    max_drawdown_peak: dd.peak_date,
    max_drawdown_trough: dd.trough_date,

    best_trade: trades.length ? trades.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null,
    worst_trade: trades.length ? trades.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null,

    exit_breakdown: trades.reduce((acc, t) => {
      acc[t.exit_reason] = (acc[t.exit_reason] || 0) + 1;
      return acc;
    }, {}),

    confidence: confidence.level,
    confidence_note: confidence.note,
  };
}

// Ordena por rentabilidad total, pero empuja al final las estrategias que
// todavia no tienen operaciones cerradas: no han demostrado nada.
function rankWorkspaces(metricsList) {
  const ranked = [...metricsList].sort((a, b) => {
    const aHas = a.closed_trades > 0 ? 1 : 0;
    const bHas = b.closed_trades > 0 ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return (b.total_return_pct || 0) - (a.total_return_pct || 0);
  });

  ranked.forEach((m, idx) => {
    m.rank = idx + 1;
  });

  const withTrades = ranked.filter((m) => m.closed_trades > 0);
  const anyReliable = withTrades.some((m) => m.confidence !== "insuficiente");

  return {
    ranking: ranked,
    leader: withTrades.length ? ranked[0].workspace : null,
    // Si nadie tiene muestra suficiente, se dice claramente en vez de coronar
    // un ganador que solo lo es por suerte.
    verdict: !withTrades.length
      ? "Sin operaciones cerradas todavia: el ranking esta vacio hasta que el tracker acumule historial."
      : !anyReliable
        ? "Hay resultados, pero ninguna estrategia tiene aun muestra suficiente. No es una conclusion."
        : `${ranked[0].label} va por delante con ${((ranked[0].total_return_pct || 0) * 100).toFixed(2)}% en ${ranked[0].closed_trades} operaciones cerradas.`,
  };
}

module.exports = { computeMetrics, rankWorkspaces, maxDrawdown, confidenceLabel };
