const { resolveWorkspace, listWorkspaces, DEFAULT_WORKSPACE } = require("../lib/workspaces");
const { getSignals } = require("../lib/runtime");
const { readState } = require("../lib/store");
const { computeMetrics } = require("../lib/metrics");

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url || "/api/signals", `https://${req.headers.host || "localhost"}`);
    const workspaceId = url.searchParams.get("workspace") || DEFAULT_WORKSPACE;
    const workspace = resolveWorkspace(workspaceId);

    const maxSymbols = Number(url.searchParams.get("maxSymbols") || 0);
    const concurrency = Number(url.searchParams.get("concurrency") || process.env.SCANNER_CONCURRENCY || 24);

    const result = await getSignals(workspace, { maxSymbols, concurrency });
    const state = readState(workspace);

    const recommendations = result.signals.filter((s) => s.authorized);
    const watch = result.signals.filter((s) => !s.authorized).concat(result.watch).slice(0, 25);

    const payload = {
      ok: true,
      workspace: {
        id: workspace.id,
        label: workspace.label,
        description: workspace.description,
        live: workspace.live,
      },
      workspaces: listWorkspaces(),
      source: result.source,
      computed_at: result.computed_at,
      generated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,
      market_date: result.market_date,
      warning: result.warning || null,
      diagnostics: result.diagnostics,
      rules: result.extra?.rules || null,
      recommendations,
      watch,
      // Estado de la cartera de paper trading de este workspace.
      portfolio: {
        equity: computeMetrics(workspace, state).equity,
        open_positions: state.positions,
        tracked_days: state.tracked_days,
        last_tracked_date: state.last_market_date,
      },
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
