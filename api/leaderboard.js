// Ranking entre estrategias. Lee el historial de paper trading que commitea
// el GitHub Action; no calcula senales ni descarga nada.

const { WORKSPACES } = require("../lib/workspaces");
const { readState } = require("../lib/store");
const { computeMetrics, rankWorkspaces } = require("../lib/metrics");

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  try {
    const metrics = Object.values(WORKSPACES).map((workspace) => computeMetrics(workspace, readState(workspace)));
    const { ranking, leader, verdict } = rankWorkspaces(metrics);

    const totalClosed = ranking.reduce((sum, m) => sum + m.closed_trades, 0);
    const trackedDays = Math.max(0, ...ranking.map((m) => m.tracked_days));

    const payload = {
      ok: true,
      generated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,
      tracked_days: trackedDays,
      total_closed_trades: totalClosed,
      leader,
      verdict,
      ranking,
      equity_curves: Object.values(WORKSPACES).map((workspace) => {
        const state = readState(workspace);
        return {
          workspace: workspace.id,
          label: workspace.label,
          points: (state.equity_curve || []).map((p) => ({ date: p.date, equity: p.equity })),
        };
      }),
      recent_trades: Object.values(WORKSPACES)
        .flatMap((workspace) =>
          (readState(workspace).trades || []).map((t) => ({ ...t, workspace: workspace.id, workspace_label: workspace.label })),
        )
        .sort((a, b) => String(b.exit_date).localeCompare(String(a.exit_date)))
        .slice(0, 40),
      method: {
        note: "Paper trading hacia delante, no backtest. Todo lo que aparece aqui ocurrio despues de escribir la estrategia.",
        shared_rules:
          "Todos los workspaces usan el mismo capital inicial, los mismos limites de posiciones y sector, y los mismos costes por operacion. Lo unico que cambia es que acciones elige cada estrategia.",
      },
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
    res.statusCode = 200;
    res.end(JSON.stringify(payload, null, 2));
  } catch (error) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error.message, generated_at: new Date().toISOString() }, null, 2));
  }
};
