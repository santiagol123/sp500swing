// Tracker diario de paper trading.
//
// Lo ejecuta el GitHub Action despues del cierre USA:
//   1. corre cada estrategia
//   2. marca a mercado las posiciones abiertas y cierra las que toquen
//   3. abre las nuevas senales autorizadas
//   4. guarda el estado en data/history/<workspace>/state.json
//
// Es idempotente por dia de mercado: si se ejecuta dos veces el mismo dia, la
// segunda no duplica operaciones.

const { WORKSPACES, resolveWorkspace } = require("../lib/workspaces");
const { runStrategy } = require("../lib/runtime");
const { readState, writeState, writeJson, readJson } = require("../lib/store");
const { trackDay } = require("../lib/papertrading");
const { computeMetrics, rankWorkspaces } = require("../lib/metrics");

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`) || arg(name, "false") === "true";
}

function usesInsiderFilingsCache(workspace) {
  return workspace.strategy === "insider" || workspace.strategy === "insider_total";
}

function filingsCacheWorkspaceId(workspace) {
  return usesInsiderFilingsCache(workspace) ? "insider" : workspace.id;
}

async function trackWorkspace(workspace, options) {
  const started = Date.now();
  console.log(`\n=== ${workspace.label} (${workspace.id}) ===`);

  // El escaneo de insiders cachea los formularios 4 ya procesados. Sin esto
  // cada ejecucion volveria a descargar miles de documentos a la SEC.
  const cache = usesInsiderFilingsCache(workspace) ? readJson(filingsCacheWorkspaceId(workspace), "filings", {}) || {} : {};
  const state = readState(workspace);
  const bootstrapSignals =
    usesInsiderFilingsCache(workspace) &&
    !state.last_market_date &&
    !state.positions.length &&
    !state.trades.length;

  const result = await runStrategy(workspace, {
    ...options,
    // El motor de cartera necesita las velas para marcar a mercado y para
    // detectar stops y objetivos. Sin esto no abriria ni cerraria nada.
    includeCharts: true,
    cache,
    cacheOnly: usesInsiderFilingsCache(workspace) && Boolean(options.cacheOnly),
    bootstrapSignals: usesInsiderFilingsCache(workspace) && (bootstrapSignals || Boolean(options.bootstrapSignals)),
    onProgress: ({ done, total, filingsFetched }) =>
      console.log(`  ... ${done}/${total} empresas, ${filingsFetched} formularios nuevos`),
  });

  const authorized = result.signals.filter((s) => s.authorized);
  console.log(`  senales: ${result.signals.length} (autorizadas: ${authorized.length})`);
  if (result.diagnostics) console.log(`  diagnostico: ${JSON.stringify(result.diagnostics)}`);

  // El snapshot permite que la API sirva insiders sin recalcular.
  writeJson(workspace.id, "signals", {
    computed_at: new Date().toISOString(),
    market_date: result.market_date,
    signals: result.signals,
    watch: result.watch || [],
    diagnostics: result.diagnostics,
    extra: result.extra || {},
  });
  if (result.cache && usesInsiderFilingsCache(workspace)) writeJson(filingsCacheWorkspaceId(workspace), "filings", result.cache);

  const outcome = trackDay(state, {
    signals: result.signals,
    charts: result.charts,
    marketDate: result.market_date,
    workspace,
  });

  if (outcome.skipped) {
    console.log(`  SALTADO: ${outcome.reason}`);
  } else {
    for (const t of outcome.closed) {
      console.log(`  CIERRE  ${t.ticker} ${t.exit_reason} ${t.pnl >= 0 ? "+" : ""}${t.pnl} $ (${(t.pnl_pct * 100).toFixed(2)}%)`);
    }
    for (const p of outcome.opened) {
      console.log(`  APERTURA ${p.ticker} @ ${p.entry_price} stop ${p.stop_price} tp ${p.target_price}`);
    }
    if (!outcome.closed.length && !outcome.opened.length) console.log("  sin movimientos");
    console.log(`  capital: ${outcome.equity.toFixed(2)} $`);
    writeState(workspace, state);
  }

  console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return state;
}

async function main() {
  const only = arg("workspace");
  const maxSymbols = Number(arg("maxSymbols", 0));
  const concurrency = Number(arg("concurrency", 24));
  const cacheOnly = flag("cacheOnly");
  const bootstrapSignals = flag("bootstrapSignals");

  const targets = only ? [resolveWorkspace(only)] : Object.values(WORKSPACES);
  console.log(`Tracking: ${targets.map((w) => w.id).join(", ")}`);

  for (const workspace of targets) {
    try {
      await trackWorkspace(workspace, { maxSymbols, concurrency, cacheOnly, bootstrapSignals });
    } catch (error) {
      // Si una estrategia falla, la otra debe seguir registrandose igualmente.
      console.error(`  ERROR en ${workspace.id}: ${error.message}`);
      process.exitCode = 1;
    }
  }

  const metrics = Object.values(WORKSPACES).map((w) => computeMetrics(w, readState(w)));
  const { verdict, ranking } = rankWorkspaces(metrics);
  console.log("\n=== RANKING ===");
  for (const m of ranking) {
    console.log(
      `  #${m.rank} ${m.label}: ${((m.total_return_pct || 0) * 100).toFixed(2)}% | ${m.closed_trades} ops | fiabilidad ${m.confidence}`,
    );
  }
  console.log(`\n${verdict}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
