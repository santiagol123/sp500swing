// Estrategia 3: insiders total.
//
// Combina la fuente SEC EDGAR que ya usa `insider` con las compras publicadas
// por Dataroma, normalizadas al mismo formato y filtradas al universo S&P 500.

const { loadUniverse } = require("../universe");
const { fetchCharts, yahooSymbol } = require("../yahoo");
const { computeRawFeature } = require("../scanner");
const { clip } = require("../indicators");
const { fetchDataromaInsiderBuys, fetchDataromaWeeklyFlow } = require("../dataroma");
const insider = require("./insider");

const MIN_FLOW_TODAY_PURCHASE_VALUE_USD = Number(process.env.DATAROMA_FLOW_MIN_TODAY_PURCHASE_USD || 250000);
const MIN_FLOW_RECENT_PURCHASE_VALUE_USD = Number(process.env.DATAROMA_FLOW_MIN_PURCHASE_USD || 500000);
const MIN_FLOW_NET_VALUE_USD = Number(process.env.DATAROMA_FLOW_MIN_NET_USD || 250000);
const MIN_FLOW_PURCHASE_SALE_RATIO = Number(process.env.DATAROMA_FLOW_MIN_BUY_SELL_RATIO || 1.75);
const MIN_STANDALONE_SENIOR_VALUE_USD = Number(process.env.INSIDER_TOTAL_MIN_STANDALONE_SENIOR_VALUE_USD || 1000000);
const STANDALONE_SENIOR_TITLE_RE =
  /\b(ceo|chief executive|cfo|chief financial|coo|chief operating|founder|co-founder|chairman|chair|president)\b/i;

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

function sumValue(rows) {
  return rows.reduce((sum, row) => sum + (Number(row.value_usd) || 0), 0);
}

function distinctOwnerCount(rows) {
  return new Set(rows.map((row) => row.owner_cik || row.owner_name).filter(Boolean)).size;
}

function compactInsiders(rows, defaultSource = "dataroma_flow") {
  const byOwner = new Map();
  for (const row of rows) {
    const key = row.owner_cik || row.owner_name;
    if (!key) continue;
    const current = byOwner.get(key) || {
      name: row.owner_name,
      title: row.owner_title,
      shares: 0,
      value_usd: 0,
      date: row.transaction_date,
      filing_date: row.filing_date || null,
      source: row.source || defaultSource,
      is_officer: Boolean(row.is_officer),
      is_director: Boolean(row.is_director),
      is_ten_percent_owner: Boolean(row.is_ten_percent_owner),
      has_10b5_1_plan: Boolean(row.has_10b5_1_plan),
    };
    current.shares += Number(row.shares || 0);
    current.value_usd += Number(row.value_usd || 0);
    if (row.transaction_date && (!current.date || row.transaction_date > current.date)) current.date = row.transaction_date;
    if (row.filing_date && (!current.filing_date || row.filing_date > current.filing_date)) current.filing_date = row.filing_date;
    current.has_10b5_1_plan = current.has_10b5_1_plan || Boolean(row.has_10b5_1_plan);
    byOwner.set(key, current);
  }

  return [...byOwner.values()]
    .sort((a, b) => b.value_usd - a.value_usd)
    .slice(0, 8)
    .map((row) => ({
      ...row,
      shares: Number(row.shares.toFixed(4)),
      value_usd: Math.round(row.value_usd),
    }));
}

function sourceCounts(rows) {
  return rows.reduce((acc, row) => {
    const key = row.source || "sec_edgar";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function isStandaloneSeniorBuy(row) {
  const title = row.owner_title || "";
  if (row.transaction_type && row.transaction_type !== "purchase") return false;
  if (row.has_10b5_1_plan) return false;
  if ((Number(row.value_usd) || 0) < MIN_STANDALONE_SENIOR_VALUE_USD) return false;
  return STANDALONE_SENIOR_TITLE_RE.test(title);
}

function standaloneSeniorScore(summary) {
  const today = new Date().toISOString().slice(0, 10);
  const filingDate = summary.last_filing || summary.last_buy;
  const freshness = filingDate ? clip(1 - dayDiff(today, filingDate) / insider.SIGNAL_FRESH_DAYS, 0, 1) : 0.35;
  const value = clip(
    Math.log10(Math.max(summary.total_value_usd, 1) / MIN_STANDALONE_SENIOR_VALUE_USD) / Math.log10(20),
    0,
    1,
  );
  const raw = 0.55 * value + 0.45 * freshness;
  return Math.round((62 + 33 * clip(raw, 0, 1)) * 10) / 10;
}

function buildStandaloneSeniorCandidates(buysByTicker) {
  const candidates = [];
  for (const [ticker, rows] of buysByTicker) {
    const byOwner = new Map();
    for (const row of rows || []) {
      if (!isStandaloneSeniorBuy(row)) continue;
      const ownerKey = row.owner_cik || row.owner_name;
      if (!ownerKey) continue;
      const current =
        byOwner.get(ownerKey) || {
          ticker,
          owner_key: ownerKey,
          owner_name: row.owner_name,
          owner_title: row.owner_title,
          rows: [],
          total_value_usd: 0,
          total_shares: 0,
        };
      current.rows.push(row);
      current.total_value_usd += Number(row.value_usd || 0);
      current.total_shares += Number(row.shares || 0);
      if (!current.owner_title && row.owner_title) current.owner_title = row.owner_title;
      byOwner.set(ownerKey, current);
    }

    const summaries = [...byOwner.values()]
      .filter((summary) => summary.total_value_usd >= MIN_STANDALONE_SENIOR_VALUE_USD)
      .map((summary) => {
        const buyDates = summary.rows.map((row) => row.transaction_date).filter(Boolean).sort();
        const filingDates = summary.rows.map((row) => row.filing_date).filter(Boolean).sort();
        const next = {
          ...summary,
          buy_count: summary.rows.length,
          insider_count: 1,
          total_value_usd: Math.round(summary.total_value_usd),
          total_shares: Number(summary.total_shares.toFixed(4)),
          first_buy: buyDates[0] || null,
          last_buy: buyDates.at(-1) || null,
          first_filing: filingDates[0] || null,
          last_filing: filingDates.at(-1) || null,
          sources: sourceCounts(summary.rows),
          insiders: compactInsiders(summary.rows, "dataroma"),
        };
        return { ticker, summary: next, opt_score: standaloneSeniorScore(next) };
      })
      .sort((a, b) => b.opt_score - a.opt_score);

    if (summaries.length) candidates.push(summaries[0]);
  }

  return candidates.sort((a, b) => b.opt_score - a.opt_score);
}

function flowScore(summary) {
  const value = clip(Math.log10(Math.max(summary.purchase_value_usd, 1) / MIN_FLOW_RECENT_PURCHASE_VALUE_USD) / Math.log10(20), 0, 1);
  const net = clip(Math.log10(Math.max(summary.net_value_usd, 1) / MIN_FLOW_NET_VALUE_USD) / Math.log10(20), 0, 1);
  const ratio =
    summary.sale_value_usd > 0
      ? clip((Math.min(summary.purchase_sale_ratio, 6) - MIN_FLOW_PURCHASE_SALE_RATIO) / (6 - MIN_FLOW_PURCHASE_SALE_RATIO), 0, 1)
      : 1;
  const breadth = clip((summary.purchase_insider_count - 1) / 3, 0, 1);
  const raw = 0.30 * value + 0.30 * net + 0.25 * ratio + 0.15 * breadth;
  return Math.round((55 + 40 * clip(raw, 0, 1)) * 10) / 10;
}

function buildDataromaFlowCandidates(rows, latestFilingDate) {
  if (!latestFilingDate) return [];
  const byTicker = new Map();
  for (const row of rows || []) {
    const ticker = yahooSymbol(row.symbol).toUpperCase();
    if (!ticker) continue;
    if (!byTicker.has(ticker)) byTicker.set(ticker, []);
    byTicker.get(ticker).push({ ...row, symbol: ticker });
  }

  const candidates = [];
  for (const [ticker, tickerRows] of byTicker) {
    const purchases = tickerRows.filter((row) => row.transaction_type === "purchase");
    const sales = tickerRows.filter((row) => row.transaction_type === "sale");
    const todaysPurchases = purchases.filter((row) => row.filing_date === latestFilingDate);
    if (!todaysPurchases.length) continue;

    const purchaseValue = sumValue(purchases);
    const saleValue = sumValue(sales);
    const todayPurchaseValue = sumValue(todaysPurchases);
    const netValue = purchaseValue - saleValue;
    const ratio = saleValue > 0 ? purchaseValue / saleValue : null;
    const ratioOk = saleValue <= 0 || ratio >= MIN_FLOW_PURCHASE_SALE_RATIO;

    if (todayPurchaseValue < MIN_FLOW_TODAY_PURCHASE_VALUE_USD) continue;
    if (purchaseValue < MIN_FLOW_RECENT_PURCHASE_VALUE_USD) continue;
    if (netValue < MIN_FLOW_NET_VALUE_USD) continue;
    if (!ratioOk) continue;

    const purchaseDates = purchases.map((row) => row.transaction_date).filter(Boolean).sort();
    const saleDates = sales.map((row) => row.transaction_date).filter(Boolean).sort();
    const summary = {
      ticker,
      latest_filing_date: latestFilingDate,
      purchase_value_usd: Math.round(purchaseValue),
      sale_value_usd: Math.round(saleValue),
      net_value_usd: Math.round(netValue),
      today_purchase_value_usd: Math.round(todayPurchaseValue),
      purchase_sale_ratio: ratio == null ? null : Number(ratio.toFixed(3)),
      purchase_orders: purchases.length,
      sale_orders: sales.length,
      today_purchase_orders: todaysPurchases.length,
      purchase_insider_count: distinctOwnerCount(purchases),
      sale_insider_count: distinctOwnerCount(sales),
      first_purchase: purchaseDates[0] || null,
      last_purchase: purchaseDates.at(-1) || null,
      first_sale: saleDates[0] || null,
      last_sale: saleDates.at(-1) || null,
      insiders: compactInsiders(purchases),
    };
    candidates.push({ ticker, summary, opt_score: flowScore(summary) });
  }

  return candidates.sort((a, b) => b.opt_score - a.opt_score);
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

async function loadDataromaFlow(universe, options) {
  try {
    const result = await fetchDataromaWeeklyFlow({
      maxPages: Number(options.dataromaFlowMaxPages || process.env.DATAROMA_FLOW_MAX_PAGES || 25),
      universeTickers: universe.map((row) => row.ticker),
    });
    return { rows: result.rows, latestFilingDate: result.latest_filing_date, stats: result.stats, error: null };
  } catch (error) {
    return {
      rows: [],
      latestFilingDate: null,
      stats: {
        dataroma_flow_error: error.message,
        dataroma_flow_rows_after_filters: 0,
        dataroma_flow_pages_fetched: 0,
      },
      error,
    };
  }
}

function buildClusterSignal({ ticker, cluster, feature, meta, freshnessLimit, today, bootstrapSignals }) {
  const plan = insider.buildTradePlan(feature, cluster);
  const staleDays = dayDiff(today, cluster.last_buy);
  const fresh = staleDays <= freshnessLimit;
  const bootstrapFresh = Boolean(bootstrapSignals && staleDays > insider.SIGNAL_FRESH_DAYS && staleDays <= freshnessLimit);
  const reward = plan.target_price / feature.price - 1;
  const risk = (feature.price - plan.invalid_below_price) / feature.price;
  const sources = sourceSummary(cluster);

  return {
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
      first_filing: cluster.first_filing || null,
      last_filing: cluster.last_filing || null,
      has_10b5_1_plan: Boolean(cluster.has_10b5_1_plan),
      rsi14: feature.rsi14,
      volatility_20d: feature.volatility_20d,
    },
  };
}

function buildFlowSignal({ ticker, summary, feature, meta }) {
  const plan = insider.buildTradePlan(feature, { total_value_usd: summary.purchase_value_usd });
  const reward = plan.target_price / feature.price - 1;
  const risk = (feature.price - plan.invalid_below_price) / feature.price;
  const ratioText = summary.purchase_sale_ratio == null ? "sin ventas recientes" : `${summary.purchase_sale_ratio.toFixed(2)}x ventas`;

  return {
    ticker,
    name: meta.name || feature.name,
    sector: meta.gics_sector || "",
    strategy: "insider_total",
    family: "DATAROMA_NET_PURCHASE_FLOW",
    action: "COMPRAR_LIMITADA",
    reason:
      `Flujo Dataroma semanal: compras ${summary.purchase_value_usd.toLocaleString("en-US")} USD vs ventas ${summary.sale_value_usd.toLocaleString("en-US")} USD (${ratioText}); ` +
      `neto comprador ${summary.net_value_usd.toLocaleString("en-US")} USD. Compras publicadas el ${summary.latest_filing_date}: ${summary.today_purchase_value_usd.toLocaleString("en-US")} USD.`,
    plan: "Entrada limitada dentro de zona; flujo neto comprador de insiders en la ultima semana",
    last_close: feature.price,
    entry_zone_low: plan.entry_zone_low,
    entry_zone_high: plan.entry_zone_high,
    invalid_below_price: plan.invalid_below_price,
    target_price: plan.target_price,
    risk_reward_ratio: risk > 0 ? reward / risk : null,
    size_pct: plan.max_position_pct,
    authorized: false,
    opt_score: summary.opt_score,
    meta: {
      insider_count: summary.purchase_insider_count,
      buy_count: summary.purchase_orders,
      total_value_usd: summary.purchase_value_usd,
      first_buy: summary.first_purchase,
      last_buy: summary.last_purchase,
      stale_days: 0,
      bootstrap_signal: false,
      sources: { dataroma_flow: summary.purchase_orders },
      insiders: summary.insiders,
      dataroma_flow: summary,
      rsi14: feature.rsi14,
      volatility_20d: feature.volatility_20d,
    },
  };
}

function buildStandaloneSeniorSignal({ ticker, summary, feature, meta, freshnessLimit, today, bootstrapSignals }) {
  const plan = insider.buildTradePlan(feature, { total_value_usd: summary.total_value_usd });
  const filingDate = summary.last_filing || summary.last_buy;
  const staleDays = filingDate ? dayDiff(today, filingDate) : Number.POSITIVE_INFINITY;
  const fresh = staleDays <= freshnessLimit;
  const bootstrapFresh = Boolean(bootstrapSignals && staleDays > insider.SIGNAL_FRESH_DAYS && staleDays <= freshnessLimit);
  const reward = plan.target_price / feature.price - 1;
  const risk = (feature.price - plan.invalid_below_price) / feature.price;
  const sources = sourceSummary({ sources: summary.sources });
  const ownerText = `${summary.owner_name || "Insider"}${summary.owner_title ? ` (${summary.owner_title})` : ""}`;

  return {
    ticker,
    name: meta.name || feature.name,
    sector: meta.gics_sector || "",
    strategy: "insider_total",
    family: "INSIDER_TOTAL_SINGLE_SENIOR",
    action: fresh ? (bootstrapFresh ? "COMPRAR_BOOTSTRAP" : "COMPRAR_LIMITADA") : "SENAL_CADUCADA",
    reason: fresh
      ? `Compra senior material: ${ownerText} compro ${summary.total_value_usd.toLocaleString("en-US")} USD entre ${summary.first_buy} y ${summary.last_buy}${sources ? ` | fuentes: ${sources}` : ""}`
      : `Compra senior material de ${filingDate || summary.last_buy || "fecha desconocida"}, demasiado antigua${sources ? ` | fuentes: ${sources}` : ""}`,
    plan: fresh ? "Entrada limitada dentro de zona; compra individual senior de importe alto" : "Solo seguimiento",
    last_close: feature.price,
    entry_zone_low: plan.entry_zone_low,
    entry_zone_high: plan.entry_zone_high,
    invalid_below_price: plan.invalid_below_price,
    target_price: plan.target_price,
    risk_reward_ratio: risk > 0 ? reward / risk : null,
    size_pct: fresh ? plan.max_position_pct : 0,
    authorized: false,
    opt_score: summary.opt_score,
    meta: {
      insider_count: summary.insider_count,
      buy_count: summary.buy_count,
      total_value_usd: summary.total_value_usd,
      first_buy: summary.first_buy,
      last_buy: summary.last_buy,
      stale_days: Number.isFinite(staleDays) ? Math.round(staleDays) : null,
      bootstrap_signal: bootstrapFresh,
      sources: summary.sources,
      insiders: summary.insiders,
      first_filing: summary.first_filing,
      last_filing: summary.last_filing,
      has_10b5_1_plan: false,
      senior_single_signal: true,
      standalone_senior_min_value_usd: MIN_STANDALONE_SENIOR_VALUE_USD,
      rsi14: feature.rsi14,
      volatility_20d: feature.volatility_20d,
    },
  };
}

function upsertSignal(signals, signalByTicker, signal) {
  const current = signalByTicker.get(signal.ticker);
  if (!current) {
    signals.push(signal);
    signalByTicker.set(signal.ticker, signal);
    return signal;
  }

  current.opt_score = Math.max(current.opt_score || 0, signal.opt_score || 0);
  current.meta = {
    ...current.meta,
    dataroma_flow: signal.meta?.dataroma_flow || current.meta?.dataroma_flow,
    flow_confirmed: signal.family === "DATAROMA_NET_PURCHASE_FLOW" || current.meta?.flow_confirmed,
  };
  if (signal.family === "DATAROMA_NET_PURCHASE_FLOW") {
    current.reason = `${current.reason} | ${signal.reason}`;
    current.meta.sources = {
      ...(current.meta.sources || {}),
      dataroma_flow: signal.meta?.sources?.dataroma_flow || 0,
    };
  }
  if (actionPriority(signal) > actionPriority(current)) {
    current.action = signal.action;
    current.plan = signal.plan;
    current.size_pct = Math.max(current.size_pct || 0, signal.size_pct || 0);
  }
  return current;
}

async function run(options = {}) {
  const startedAt = Date.now();
  const { universe, source } = await loadUniverse();
  const maxSymbols = Number(options.maxSymbols || 0);
  const selectedUniverse = maxSymbols > 0 ? universe.slice(0, maxSymbols) : universe;
  const metaByTicker = new Map(universe.map((row) => [row.ticker, row]));
  const [sec, dataroma, flow] = await Promise.all([
    loadSecBuys(selectedUniverse, options),
    loadDataromaBuys(selectedUniverse, options),
    loadDataromaFlow(selectedUniverse, options),
  ]);
  const merged = mergeBuysByTicker(sec.buysByTicker, dataroma.rows);
  const flowCandidates = buildDataromaFlowCandidates(flow.rows, flow.latestFilingDate);
  const standaloneSeniorCandidates = buildStandaloneSeniorCandidates(merged.buysByTicker);

  const clusters = [];
  for (const [ticker, buys] of merged.buysByTicker) {
    const cluster = insider.findCluster(buys);
    if (cluster) clusters.push({ ticker, cluster });
  }

  const tickers = [
    ...new Set([...clusters.map((c) => c.ticker), ...flowCandidates.map((c) => c.ticker), ...standaloneSeniorCandidates.map((c) => c.ticker)]),
  ];
  const { ok, failed } = tickers.length ? await fetchCharts(tickers, Number(options.concurrency || 12)) : { ok: [], failed: [] };
  const featureByTicker = new Map(ok.map((chart) => [chart.symbol, computeRawFeature(chart, metaByTicker)]));

  const today = new Date().toISOString().slice(0, 10);
  const freshnessLimit = options.bootstrapSignals ? insider.BOOTSTRAP_SIGNAL_FRESH_DAYS : insider.SIGNAL_FRESH_DAYS;
  const signals = [];
  const signalByTicker = new Map();

  for (const { ticker, cluster } of clusters) {
    const feature = featureByTicker.get(ticker);
    if (!feature || !Number.isFinite(feature.price)) continue;
    const meta = metaByTicker.get(ticker) || {};
    upsertSignal(
      signals,
      signalByTicker,
      buildClusterSignal({ ticker, cluster, feature, meta, freshnessLimit, today, bootstrapSignals: Boolean(options.bootstrapSignals) }),
    );
  }

  for (const { ticker, summary, opt_score: optScore } of flowCandidates) {
    const feature = featureByTicker.get(ticker);
    if (!feature || !Number.isFinite(feature.price)) continue;
    const meta = metaByTicker.get(ticker) || {};
    upsertSignal(signals, signalByTicker, buildFlowSignal({ ticker, summary: { ...summary, opt_score: optScore }, feature, meta }));
  }

  for (const { ticker, summary, opt_score: optScore } of standaloneSeniorCandidates) {
    const feature = featureByTicker.get(ticker);
    if (!feature || !Number.isFinite(feature.price)) continue;
    const meta = metaByTicker.get(ticker) || {};
    upsertSignal(
      signals,
      signalByTicker,
      buildStandaloneSeniorSignal({
        ticker,
        summary: { ...summary, opt_score: optScore },
        feature,
        meta,
        freshnessLimit,
        today,
        bootstrapSignals: Boolean(options.bootstrapSignals),
      }),
    );
  }

  signals.sort((a, b) => actionPriority(b) - actionPriority(a) || b.opt_score - a.opt_score);
  if (!options.skipAuthorization) {
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
      companies_with_dataroma_flow: new Set(flow.rows.map((row) => row.symbol)).size,
      companies_with_buys: merged.buysByTicker.size,
      clusters_found: clusters.length,
      dataroma_flow_candidates: flowCandidates.length,
      standalone_senior_candidates: standaloneSeniorCandidates.length,
      signals_fresh: signals.filter((s) => s.action === "COMPRAR_LIMITADA" || s.action === "COMPRAR_BOOTSTRAP" || s.authorized).length,
      portfolio_entry_count: signals.filter((s) => s.authorized).length,
      price_download_failed: failed.length,
      dataroma_ok: !dataroma.error,
      dataroma_flow_ok: !flow.error,
      ...sec.stats,
      ...dataroma.stats,
      ...flow.stats,
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
        dataroma_flow_max_pages: Number(options.dataromaFlowMaxPages || process.env.DATAROMA_FLOW_MAX_PAGES || 25),
        min_flow_today_purchase_value_usd: MIN_FLOW_TODAY_PURCHASE_VALUE_USD,
        min_flow_recent_purchase_value_usd: MIN_FLOW_RECENT_PURCHASE_VALUE_USD,
        min_flow_net_value_usd: MIN_FLOW_NET_VALUE_USD,
        min_flow_purchase_sale_ratio: MIN_FLOW_PURCHASE_SALE_RATIO,
        min_standalone_senior_value_usd: MIN_STANDALONE_SENIOR_VALUE_USD,
        note: "Combina compras SEC EDGAR, compras Dataroma y flujo semanal Dataroma compra/venta; filtra al universo S&P 500.",
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
  buildDataromaFlowCandidates,
  buildStandaloneSeniorCandidates,
};
