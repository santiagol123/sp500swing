// Estrategia 2: compras agrupadas de directivos ("cluster buying").
//
// Un solo directivo comprando dice poco: puede ser rutina, imagen o
// diversificacion personal. La senal que la literatura academica encuentra
// mas robusta es que VARIOS insiders distintos de la misma empresa compren en
// mercado abierto en una ventana corta. Eso es lo que se exige aqui.
//
// Solo cuenta el codigo P del formulario 4 (compra en mercado abierto).
// Se ignoran concesiones (A), ejercicios de opciones (M) y retenciones
// fiscales (F), que no expresan conviccion.

const { loadTickerCikMap, fetchRecentForm4Filings, fetchForm4, extractInsiderBuys } = require("../edgar");
const { loadUniverse } = require("../universe");
const { fetchCharts } = require("../yahoo");
const { computeRawFeature } = require("../scanner");
const { clip } = require("../indicators");

// Cuanto historial de formularios 4 se descarga.
const LOOKBACK_DAYS = 90;
// Ventana en la que las compras deben concentrarse para considerarse cluster.
const CLUSTER_WINDOW_DAYS = 30;
// Insiders distintos necesarios.
const MIN_CLUSTER_INSIDERS = 2;
// La ventaja informativa de una compra de insider decae rapido: si la compra
// mas reciente del cluster ya es vieja, no se abre posicion nueva.
const SIGNAL_FRESH_DAYS = 15;
// Al crear por primera vez la cartera insider desde datos ya cacheados, se
// permite sembrar clusters recientes del lookback para no dejar la cartera vacia.
const BOOTSTRAP_SIGNAL_FRESH_DAYS = 120;
// Filtra compras simbolicas.
const MIN_CLUSTER_VALUE_USD = 50000;

const MAX_NEW_BUYS_PER_DAY = 3;
const MAX_BUYS_PER_SECTOR_PER_DAY = 2;

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

function dayDiff(a, b) {
  return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

// El universo usa formato Yahoo (BRK-B). company_tickers.json usa el mismo,
// pero probamos ambas variantes por seguridad.
function lookupCik(cikMap, ticker) {
  const upper = String(ticker).toUpperCase();
  return cikMap.get(upper) || cikMap.get(upper.replace(/-/g, ".")) || cikMap.get(upper.replace(/\./g, "-")) || null;
}

// Agrupa las compras de una empresa en clusters por proximidad temporal y se
// queda con el mas reciente que cumpla el minimo de insiders distintos.
function findCluster(buys) {
  if (buys.length < MIN_CLUSTER_INSIDERS) return null;

  const sorted = [...buys].sort((a, b) => String(b.transaction_date).localeCompare(String(a.transaction_date)));

  for (const anchor of sorted) {
    const members = sorted.filter((b) => dayDiff(b.transaction_date, anchor.transaction_date) <= CLUSTER_WINDOW_DAYS);
    const distinct = new Map();
    for (const m of members) distinct.set(m.owner_cik || m.owner_name, m);
    if (distinct.size < MIN_CLUSTER_INSIDERS) continue;

    const insiders = [...distinct.values()];
    const totalValue = members.reduce((sum, m) => sum + (m.value_usd || 0), 0);
    if (totalValue < MIN_CLUSTER_VALUE_USD) continue;

    const dates = members.map((m) => m.transaction_date).filter(Boolean).sort();
    const filingDates = members.map((m) => m.filing_date).filter(Boolean).sort();
    const sources = members.reduce((acc, m) => {
      const key = m.source || "sec_edgar";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      insider_count: distinct.size,
      buy_count: members.length,
      total_value_usd: totalValue,
      total_shares: members.reduce((sum, m) => sum + (m.shares || 0), 0),
      first_buy: dates[0],
      last_buy: dates[dates.length - 1],
      first_filing: filingDates[0] || null,
      last_filing: filingDates[filingDates.length - 1] || null,
      has_10b5_1_plan: members.some((m) => m.has_10b5_1_plan),
      sources,
      has_officer: insiders.some((m) => m.is_officer),
      has_director: insiders.some((m) => m.is_director),
      insiders: insiders.map((m) => ({
        name: m.owner_name,
        title: m.owner_title,
        shares: m.shares,
        value_usd: Math.round(m.value_usd || 0),
        date: m.transaction_date,
        filing_date: m.filing_date || null,
        source: m.source || "sec_edgar",
        is_officer: Boolean(m.is_officer),
        is_director: Boolean(m.is_director),
        is_ten_percent_owner: Boolean(m.is_ten_percent_owner),
        has_10b5_1_plan: Boolean(m.has_10b5_1_plan),
      })),
    };
  }
  return null;
}

function buysByTickerFromCache(cache = {}) {
  const buysByTicker = new Map();
  let accessions_cached = 0;
  let buy_rows_cached = 0;

  for (const rows of Object.values(cache || {})) {
    accessions_cached += 1;
    if (!Array.isArray(rows) || !rows.length) continue;
    for (const row of rows) {
      const ticker = String(row.symbol || "").trim().toUpperCase();
      if (!ticker) continue;
      if (!buysByTicker.has(ticker)) buysByTicker.set(ticker, []);
      buysByTicker.get(ticker).push(row);
      buy_rows_cached += 1;
    }
  }

  return {
    buysByTicker,
    stats: {
      accessions_cached,
      buy_rows_cached,
      tickers_with_cached_buys: buysByTicker.size,
    },
  };
}

// Puntua la conviccion del cluster: mas insiders, mas dinero y mas reciente
// puntuan mas. Un C-level pesa mas que un consejero.
function clusterScore(cluster) {
  const insiders = clip((cluster.insider_count - 2) / 3, 0, 1);
  const value = clip(Math.log10(Math.max(cluster.total_value_usd, 1) / 50000) / Math.log10(40), 0, 1);
  const freshness = clip(1 - dayDiff(new Date().toISOString().slice(0, 10), cluster.last_buy) / SIGNAL_FRESH_DAYS, 0, 1);
  const seniority = cluster.insiders.some((i) => /chief|ceo|cfo|president/i.test(i.title || "")) ? 1 : 0.5;
  const raw = 0.30 * insiders + 0.30 * value + 0.20 * freshness + 0.20 * seniority;
  return Math.round(1000 * clip(raw, 0, 1)) / 10;
}

// Plan de trade por volatilidad. Los mismos tramos de tamano que momentum
// (lib/scanner.js addTradePlan) para que el ranking compare la senal y no el
// tamano de la apuesta. Los stops son mas anchos porque la tesis de un insider
// tarda semanas o meses en materializarse, no dias.
function buildTradePlan(feature, cluster) {
  const dailyVol = clip((feature.volatility_20d || 0.25) / Math.sqrt(252), 0.008, 0.05);
  const stopLossPct = clip(2.2 * dailyVol, 0.06, 0.14);
  const takeProfitPct = clip(2.0 * stopLossPct, 0.12, 0.28);
  const price = feature.price;

  let maxPositionPct = feature.volatility_20d <= 0.30 ? 0.10 : 0.07;
  if (feature.volatility_20d >= 0.45) maxPositionPct = 0.05;

  return {
    entry_zone_low: price * 0.985,
    entry_zone_high: price * 1.02,
    invalid_below_price: price * (1 - stopLossPct),
    target_price: price * (1 + takeProfitPct),
    stop_loss_pct: stopLossPct,
    take_profit_pct: takeProfitPct,
    max_position_pct: maxPositionPct,
  };
}

async function collectInsiderBuys(universe, { cache = {}, onProgress = null, maxSymbols = 0 } = {}) {
  const cikMap = await loadTickerCikMap();
  const since = daysAgo(LOOKBACK_DAYS);
  const rows = universe.slice(0, maxSymbols > 0 ? maxSymbols : universe.length);

  const buysByTicker = new Map();
  const newCache = {};
  let filingsSeen = 0;
  let filingsFetched = 0;
  let missingCik = 0;
  let done = 0;

  for (const entry of rows) {
    done += 1;
    const cik = lookupCik(cikMap, entry.ticker);
    if (!cik) {
      missingCik += 1;
      continue;
    }

    let filings = [];
    try {
      filings = await fetchRecentForm4Filings(cik, since);
    } catch (error) {
      continue;
    }
    filingsSeen += filings.length;

    const buys = [];
    for (const filing of filings) {
      // Un formulario 4 ya presentado nunca cambia: se cachea para siempre.
      if (Object.prototype.hasOwnProperty.call(cache, filing.accession)) {
        const cached = cache[filing.accession];
        newCache[filing.accession] = cached;
        if (cached.length) buys.push(...cached);
        continue;
      }
      try {
        const form4 = await fetchForm4(cik, filing);
        filingsFetched += 1;
        const extracted = extractInsiderBuys(form4);
        newCache[filing.accession] = extracted;
        if (extracted.length) buys.push(...extracted);
      } catch (error) {
        // Un formulario ilegible no debe tumbar el escaneo entero.
      }
    }

    if (buys.length) buysByTicker.set(entry.ticker, buys);
    if (onProgress && done % 25 === 0) onProgress({ done, total: rows.length, filingsFetched });
  }

  return {
    buysByTicker,
    cache: newCache,
    stats: { filings_seen: filingsSeen, filings_fetched: filingsFetched, missing_cik: missingCik, scanned: rows.length },
  };
}

async function run(options = {}) {
  const startedAt = Date.now();
  const { universe, source } = await loadUniverse();
  const metaByTicker = new Map(universe.map((row) => [row.ticker, row]));

  const fromCacheOnly = Boolean(options.cacheOnly);
  const cached = buysByTickerFromCache(options.cache || {});
  const { buysByTicker, cache, stats } = fromCacheOnly
    ? {
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
      }
    : await collectInsiderBuys(universe, options);

  // Detecta clusters antes de tocar Yahoo: normalmente quedan pocas empresas,
  // asi solo se descargan precios de las que importan.
  const clusters = [];
  for (const [ticker, buys] of buysByTicker) {
    const cluster = findCluster(buys);
    if (cluster) clusters.push({ ticker, cluster });
  }

  const tickers = clusters.map((c) => c.ticker);
  const { ok, failed } = tickers.length ? await fetchCharts(tickers, Number(options.concurrency || 12)) : { ok: [], failed: [] };
  const featureByTicker = new Map(ok.map((chart) => [chart.symbol, computeRawFeature(chart, metaByTicker)]));

  const today = new Date().toISOString().slice(0, 10);
  const freshnessLimit = options.bootstrapSignals ? BOOTSTRAP_SIGNAL_FRESH_DAYS : SIGNAL_FRESH_DAYS;
  const signals = [];

  for (const { ticker, cluster } of clusters) {
    const feature = featureByTicker.get(ticker);
    if (!feature || !Number.isFinite(feature.price)) continue;

    const plan = buildTradePlan(feature, cluster);
    const meta = metaByTicker.get(ticker) || {};
    const staleDays = dayDiff(today, cluster.last_buy);
    const fresh = staleDays <= freshnessLimit;
    const bootstrapFresh = Boolean(options.bootstrapSignals && staleDays > SIGNAL_FRESH_DAYS && staleDays <= freshnessLimit);
    const reward = plan.target_price / feature.price - 1;
    const risk = (feature.price - plan.invalid_below_price) / feature.price;

    signals.push({
      ticker,
      name: meta.name || feature.name,
      sector: meta.gics_sector || "",
      strategy: "insider",
      family: "INSIDER_CLUSTER",
      action: fresh ? (bootstrapFresh ? "COMPRAR_BOOTSTRAP" : "COMPRAR_LIMITADA") : "SENAL_CADUCADA",
      reason: fresh
        ? `${cluster.insider_count} insiders compraron ${Math.round(cluster.total_value_usd).toLocaleString("en-US")} USD entre ${cluster.first_buy} y ${cluster.last_buy}${bootstrapFresh ? " | bootstrap cartera insider" : ""}`
        : `Cluster de ${cluster.last_buy}, demasiado antiguo (${Math.round(staleDays)} dias > ${freshnessLimit})`,
      plan: fresh ? "Entrada limitada dentro de zona; tesis de semanas, no de dias" : "Solo seguimiento",
      last_close: feature.price,
      entry_zone_low: plan.entry_zone_low,
      entry_zone_high: plan.entry_zone_high,
      invalid_below_price: plan.invalid_below_price,
      target_price: plan.target_price,
      risk_reward_ratio: risk > 0 ? reward / risk : null,
      size_pct: fresh ? plan.max_position_pct : 0,
      authorized: false, // lo decide el filtro de cartera de abajo
      opt_score: clusterScore(cluster),
      meta: {
        insider_count: cluster.insider_count,
        buy_count: cluster.buy_count,
        total_value_usd: Math.round(cluster.total_value_usd),
        first_buy: cluster.first_buy,
        last_buy: cluster.last_buy,
        stale_days: Math.round(staleDays),
        bootstrap_signal: bootstrapFresh,
        insiders: cluster.insiders,
        rsi14: feature.rsi14,
        volatility_20d: feature.volatility_20d,
      },
    });
  }

  // Mismos limites de cartera que momentum: 3 nuevas al dia, 2 por sector.
  signals.sort((a, b) => b.opt_score - a.opt_score);
  const sectorCounts = new Map();
  let authorizedCount = 0;
  for (const signal of signals) {
    if (signal.action !== "COMPRAR_LIMITADA" && signal.action !== "COMPRAR_BOOTSTRAP") continue;
    const sector = signal.sector || "SIN_SECTOR";
    const sectorCount = (sectorCounts.get(sector) || 0) + 1;
    sectorCounts.set(sector, sectorCount);
    if (authorizedCount < MAX_NEW_BUYS_PER_DAY && sectorCount <= MAX_BUYS_PER_SECTOR_PER_DAY) {
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
    cache,
    diagnostics: {
      universe_source: source,
      universe_count: universe.length,
      elapsed_ms: Date.now() - startedAt,
      cache_only: fromCacheOnly,
      bootstrap_signals: Boolean(options.bootstrapSignals),
      companies_with_buys: buysByTicker.size,
      clusters_found: clusters.length,
      signals_fresh: signals.filter((s) => s.action === "COMPRAR_LIMITADA" || s.action === "COMPRAR_BOOTSTRAP" || s.authorized).length,
      portfolio_entry_count: signals.filter((s) => s.authorized).length,
      price_download_failed: failed.length,
      ...stats,
    },
    extra: {
      rules: {
        lookback_days: LOOKBACK_DAYS,
        cluster_window_days: CLUSTER_WINDOW_DAYS,
        min_cluster_insiders: MIN_CLUSTER_INSIDERS,
        min_cluster_value_usd: MIN_CLUSTER_VALUE_USD,
        signal_fresh_days: SIGNAL_FRESH_DAYS,
        bootstrap_signal_fresh_days: BOOTSTRAP_SIGNAL_FRESH_DAYS,
        max_new_buys_per_day: MAX_NEW_BUYS_PER_DAY,
        max_buys_per_sector_per_day: MAX_BUYS_PER_SECTOR_PER_DAY,
        note: "Solo compras en mercado abierto (codigo P) de directivos o consejeros.",
      },
    },
  };
}

module.exports = {
  id: "insider",
  label: "Compras de directivos",
  description:
    "Clusters de compras en mercado abierto (formulario 4, codigo P) por 2 o mas directivos/consejeros distintos de la misma empresa.",
  signal_source: "SEC EDGAR (formulario 4)",
  run,
  collectInsiderBuys,
  findCluster,
  buysByTickerFromCache,
  clusterScore,
  buildTradePlan,
  LOOKBACK_DAYS,
  CLUSTER_WINDOW_DAYS,
  MIN_CLUSTER_INSIDERS,
  MIN_CLUSTER_VALUE_USD,
  SIGNAL_FRESH_DAYS,
  BOOTSTRAP_SIGNAL_FRESH_DAYS,
  MAX_NEW_BUYS_PER_DAY,
  MAX_BUYS_PER_SECTOR_PER_DAY,
};
