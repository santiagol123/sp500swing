// Estrategia 3: insiders total.
//
// Combina la fuente SEC EDGAR que ya usa `insider` con las compras publicadas
// por Dataroma, normalizadas al mismo formato y filtradas al universo S&P 500.

const { loadUniverse } = require("../universe");
const { fetchCharts, yahooSymbol } = require("../yahoo");
const { computeRawFeature } = require("../scanner");
const { fetchDataromaInsiderBuys } = require("../dataroma");
const insider = require("./insider");

function dayDiff(a, b) {
  return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

function sourceLabel(source) {
  if (source === "dataroma") return "Dataroma";
  return "SEC EDGAR";
}

function sourceSummary(cluster) {
  const sources = cluster.sources || {};
  return Object.entries(sources)
    .map(([source, count]) => `${sourceLabel(source)} ${count}`)
    .join(" + ");
}

function actionPriority(signal) {
  if (signal.action === "COMPRAR_LIMITADA") return 2;
  if (signal.action === "COMPRAR_BOOTSTRAP") return 1;
  return 0;
}

function buyKey(row) {
  return [
    yahooSymbol(row.symbol).toUpperCase(),
    String(row.owner_name || "").toUpperCase().replace(/\s+/g, " "),
    row.transaction_date || row.filing_date || "",
    Math.round(Number(row.shares || 0)),
    Math.round(Number(row.value_usd || 0)),
  ].join("|");
}

function ownerDateKey(row) {
  return [
    yahooSymbol(row.symbol).toUpperCase(),
    String(row.owner_name || "").toUpperCase().replace(/\s+/g, " "),
    row.transaction_date || row.filing_date || "",
  ].join("|");
}

function mergeBuysByTicker(secBuys, dataromaRows) {
  const merged = new Map();
  const seen = new Set();
  const secOwnerDates = new Set();
  let secRows = 0;
  let dataromaRowsAdded = 0;
  let dataromaDuplicates = 0;

  function add(row, source) {
    const ticker = yahooSymbol(row.symbol).toUpperCase();
    if (!ticker) return false;
    const next = { ...row, symbol: ticker, source };
    const key = buyKey(next);
    if (seen.has(key)) return false;
    seen.add(key);
    if (!merged.has(ticker)) merged.set(ticker, []);
    merged.get(ticker).push(next);
    return true;
  }

  for (const [ticker, rows] of secBuys) {
    for (const row of rows || []) {
      const next = { ...row, symbol: ticker };
      if (add(next, next.source || "sec_edgar")) {
        secRows += 1;
        secOwnerDates.add(ownerDateKey(next));
      }
    }
  }

  for (const row of dataromaRows || []) {
    if (secOwnerDates.has(ownerDateKey(row))) {
      dataromaDuplicates += 1;
      continue;
    }
    if (add(row, "dataroma")) dataromaRowsAdded += 1;
    else dataromaDuplicates += 1;
  }

  return { buysByTicker: merged, stats: { sec_buy_rows: secRows, dataroma_buy_rows_added: dataromaRowsAdded, dataroma_duplicates: dataromaDuplicates } };
}

async function loadSecBuys(universe, options) {
  const fromCacheOnly = Boolean(options.cacheOnly);
  const cached = insider.buysByTickerFromCache(options.cache || {});
  if (fromCacheOnly) {
    return {
      buysByTicker: cached.buysByTicker,
      cache: options.cache || {},
      stats: {
        filings_seen: 0,
        filings_fetched: 0,
        missing_cik: 0,
        scanned: 0,
        cache_only: true,
        ...cached.stats,
      },
    };
  }
  return insider.collectInsiderBuys(universe, options);
}

async function loadDataromaBuys(universe, options) {
  try {
    const result = await fetchDataromaInsiderBuys({
      lookbackDays: insider.LOOKBACK_DAYS,
      maxPages: Number(options.dataromaMaxPages || process.env.DATAROMA_MAX_PAGES || 25),
      timeframe: options.dataromaTimeframe || process.env.DATAROMA_TIMEFRAME || "y",
      universeTickers: universe.map((row) => row.ticker),
    });
    return { rows: result.rows, stats: result.stats, error: null };
  } catch (error) {
    return {
      rows: [],
      stats: {
        dataroma_error: error.message,
        dataroma_rows_after_filters: 0,
        dataroma_pages_fetched: 0,
      },
      error,
    };
  }
}

async function run(options = {}) {
  const startedAt = Date.now();
  const { universe, source } = await loadUniverse();
  const maxSymbols = Number(options.maxSymbols || 0);
  const selectedUniverse = maxSymbols > 0 ? universe.slice(0, maxSymbols) : universe;
  const metaByTicker = new Map(universe.map((row) => [row.ticker, row]));
  const [sec, dataroma] = await Promise.all([loadSecBuys(selectedUniverse, options), loadDataromaBuys(selectedUniverse, options)]);
  const merged = mergeBuysByTicker(sec.buysByTicker, dataroma.rows);

  const clusters = [];
  for (const [ticker, buys] of merged.buysByTicker) {
    const cluster = insider.findCluster(buys);
    if (cluster) clusters.push({ ticker, cluster });
  }

  const tickers = clusters.map((c) => c.ticker);
  const { ok, failed } = tickers.length ? await fetchCharts(tickers, Number(options.concurrency || 12)) : { ok: [], failed: [] };
  const featureByTicker = new Map(ok.map((chart) => [chart.symbol, computeRawFeature(chart, metaByTicker)]));

  const today = new Date().toISOString().slice(0, 10);
  const freshnessLimit = options.bootstrapSignals ? insider.BOOTSTRAP_SIGNAL_FRESH_DAYS : insider.SIGNAL_FRESH_DAYS;
  const signals = [];

  for (const { ticker, cluster } of clusters) {
    const feature = featureByTicker.get(ticker);
    if (!feature || !Number.isFinite(feature.price)) continue;

    const plan = insider.buildTradePlan(feature, cluster);
    const meta = metaByTicker.get(ticker) || {};
    const staleDays = dayDiff(today, cluster.last_buy);
    const fresh = staleDays <= freshnessLimit;
    const bootstrapFresh = Boolean(options.bootstrapSignals && staleDays > insider.SIGNAL_FRESH_DAYS && staleDays <= freshnessLimit);
    const reward = plan.target_price / feature.price - 1;
    const risk = (feature.price - plan.invalid_below_price) / feature.price;
    const sources = sourceSummary(cluster);

    signals.push({
      ticker,
      name: meta.name || feature.name,
      sector: meta.gics_sector || "",
      strategy: "insider_total",
      family: "INSIDER_TOTAL_CLUSTER",
      action: fresh ? (bootstrapFresh ? "COMPRAR_BOOTSTRAP" : "COMPRAR_LIMITADA") : "SENAL_CADUCADA",
      reason: fresh
        ? `${cluster.insider_count} insiders compraron ${Math.round(cluster.total_value_usd).toLocaleString("en-US")} USD entre ${cluster.first_buy} y ${cluster.last_buy}${sources ? ` | fuentes: ${sources}` : ""}${bootstrapFresh ? " | bootstrap cartera insider total" : ""}`
        : `Cluster de ${cluster.last_buy}, demasiado antiguo (${Math.round(staleDays)} dias > ${freshnessLimit})${sources ? ` | fuentes: ${sources}` : ""}`,
      plan: fresh ? "Entrada limitada dentro de zona; tesis de semanas, no de dias" : "Solo seguimiento",
      last_close: feature.price,
      entry_zone_low: plan.entry_zone_low,
      entry_zone_high: plan.entry_zone_high,
      invalid_below_price: plan.invalid_below_price,
      target_price: plan.target_price,
      risk_reward_ratio: risk > 0 ? reward / risk : null,
      size_pct: fresh ? plan.max_position_pct : 0,
      authorized: false,
      opt_score: insider.clusterScore(cluster),
      meta: {
        insider_count: cluster.insider_count,
        buy_count: cluster.buy_count,
        total_value_usd: Math.round(cluster.total_value_usd),
        first_buy: cluster.first_buy,
        last_buy: cluster.last_buy,
        stale_days: Math.round(staleDays),
        bootstrap_signal: bootstrapFresh,
        sources: cluster.sources || {},
        insiders: cluster.insiders,
        rsi14: feature.rsi14,
        volatility_20d: feature.volatility_20d,
      },
    });
  }

  signals.sort((a, b) => actionPriority(b) - actionPriority(a) || b.opt_score - a.opt_score);
  const sectorCounts = new Map();
  let authorizedCount = 0;
  for (const signal of signals) {
    if (signal.action !== "COMPRAR_LIMITADA" && signal.action !== "COMPRAR_BOOTSTRAP") continue;
    const sector = signal.sector || "SIN_SECTOR";
    const sectorCount = (sectorCounts.get(sector) || 0) + 1;
    sectorCounts.set(sector, sectorCount);
    if (authorizedCount < insider.MAX_NEW_BUYS_PER_DAY && sectorCount <= insider.MAX_BUYS_PER_SECTOR_PER_DAY) {
      signal.authorized = true;
      authorizedCount += 1;
    } else {
      signal.action = "ESPERAR_LIMITE_CARTERA";
      signal.reason = `${signal.reason} | bloqueada por limite diario o de sector`;
      signal.size_pct = 0;
    }
  }

  return {
    signals,
    watch: [],
    charts: ok,
    market_date: ok.length ? ok.map((c) => c.rows.at(-1)?.date).sort().at(-1) : null,
    cache: sec.cache,
    diagnostics: {
      universe_source: source,
      universe_count: universe.length,
      scanned_universe_count: selectedUniverse.length,
      elapsed_ms: Date.now() - startedAt,
      cache_only: Boolean(options.cacheOnly),
      bootstrap_signals: Boolean(options.bootstrapSignals),
      companies_with_sec_buys: sec.buysByTicker.size,
      companies_with_dataroma_buys: new Set(dataroma.rows.map((row) => row.symbol)).size,
      companies_with_buys: merged.buysByTicker.size,
      clusters_found: clusters.length,
      signals_fresh: signals.filter((s) => s.action === "COMPRAR_LIMITADA" || s.action === "COMPRAR_BOOTSTRAP" || s.authorized).length,
      portfolio_entry_count: signals.filter((s) => s.authorized).length,
      price_download_failed: failed.length,
      dataroma_ok: !dataroma.error,
      ...sec.stats,
      ...dataroma.stats,
      ...merged.stats,
    },
    extra: {
      rules: {
        lookback_days: insider.LOOKBACK_DAYS,
        cluster_window_days: insider.CLUSTER_WINDOW_DAYS,
        min_cluster_insiders: insider.MIN_CLUSTER_INSIDERS,
        min_cluster_value_usd: insider.MIN_CLUSTER_VALUE_USD,
        signal_fresh_days: insider.SIGNAL_FRESH_DAYS,
        bootstrap_signal_fresh_days: insider.BOOTSTRAP_SIGNAL_FRESH_DAYS,
        max_new_buys_per_day: insider.MAX_NEW_BUYS_PER_DAY,
        max_buys_per_sector_per_day: insider.MAX_BUYS_PER_SECTOR_PER_DAY,
        dataroma_timeframe: options.dataromaTimeframe || process.env.DATAROMA_TIMEFRAME || "y",
        dataroma_max_pages: Number(options.dataromaMaxPages || process.env.DATAROMA_MAX_PAGES || 25),
        note: "Combina compras SEC EDGAR (formulario 4, codigo P) y compras publicadas por Dataroma; filtra al universo S&P 500.",
      },
    },
  };
}

module.exports = {
  id: "insider_total",
  label: "Insiders total",
  description: "Clusters de compras insider combinando SEC EDGAR y Dataroma.",
  signal_source: "SEC EDGAR + Dataroma",
  run,
  mergeBuysByTicker,
};
