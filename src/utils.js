export function money(value, currency = "EUR") {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency,
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(Number(value || 0));
}

export function usd(value) {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(Number(value || 0));
}

export function pct(value, digits = 1) {
  const n = Number(value || 0);
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function number(value, digits = 2) {
  return new Intl.NumberFormat("es-ES", {
    maximumFractionDigits: digits,
  }).format(Number(value || 0));
}

export function positionMetrics(position) {
  const gross = (position.current - position.entry) * position.shares;
  const fees = (position.commissionIn || 0) + (position.commissionOut || 0);
  const pnl = gross - fees;
  const invested = position.entry * position.shares + (position.commissionIn || 0);
  const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;
  const toStop = position.current > 0 ? ((position.stop / position.current) - 1) * 100 : 0;
  const toTarget = position.current > 0 ? ((position.target / position.current) - 1) * 100 : 0;
  return { pnl, pnlPct, invested, toStop, toTarget };
}

export function actionTone(action = "") {
  if (action.includes("COMPRAR")) return "buy";
  if (action.includes("INVALIDADA")) return "bad";
  if (action.includes("BLOQUEADA")) return "muted";
  if (action.includes("CARTERA") || action.includes("MANTENER")) return "neutral";
  if (action.includes("ESPERAR")) return "wait";
  return "neutral";
}

export function makeSeries(seed = 1, length = 28, base = 100) {
  let value = base;
  return Array.from({ length }, (_, index) => {
    const wave = Math.sin((index + seed) * 0.72) * 1.4;
    const drift = index * 0.22;
    const chop = (((seed * 17 + index * 13) % 11) - 5) * 0.18;
    value = value + wave * 0.18 + chop + 0.15;
    return Number((value + drift).toFixed(2));
  });
}

export function mapApiRow(row, index = 0) {
  return {
    ticker: row.ticker,
    name: row.name || row.ticker,
    sector: row.gics_sector || row.sector || "Sin sector",
    action: row.Accion_Ejecucion || "REVISAR_MANUAL",
    strategy: row.strategy_family || row.Accion || "SCANNER",
    rank: row.rank_today || index + 1,
    price: row.last_close || row.price || 0,
    entryLow: row.entry_zone_low || row.last_close || 0,
    entryHigh: row.entry_zone_high || row.last_close || 0,
    stop: row.invalid_below_price || 0,
    target: row.target_price || 0,
    rr: row.risk_reward_ratio || 0,
    rsi: row.rsi14 || 0,
    macdHist: row.macd_hist || 0,
    score: row.score || row.opt_score || 0,
    allocation: row.portfolio_allowed ? 2000 : 0,
    reason: row.Motivo_Ejecucion || row.risk_flags || "Senal generada por scanner.",
    risk: row.Plan_Orden || row.portfolio_limit_reason || "Revisar gap de apertura y liquidez antes de ejecutar.",
  };
}

function uniqueRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = row.ticker || `${row.name}-${out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function mergeApiData(base, payload) {
  if (!payload || payload.ok === false) {
    return {
      ...base,
      meta: {
        ...base.meta,
        mode: "error",
        generatedAt: payload?.generated_at || new Date().toISOString(),
        error: payload?.error || "Respuesta API invalida",
      },
    };
  }

  const mappedBuys = (payload.recommendations || []).map(mapApiRow);
  const mappedTechnical = (payload.technical_entries || []).map(mapApiRow);
  const mappedWatch = (payload.watch || []).slice(0, 20).map(mapApiRow);
  const mappedTopRanked = payload.top_ranked || [];
  const buyToday = uniqueRows(mappedBuys).slice(0, 12);
  const technicalEntries = uniqueRows(mappedTechnical).slice(0, 20);
  const watchlist = mappedWatch.length ? mappedWatch : mappedTopRanked.slice(0, 20).map(mapApiRow);

  return {
    ...base,
    buyToday,
    technicalEntries,
    watchlist,
    topRanked: mappedTopRanked,
    portfolio: payload.portfolio?.open_positions || [],
    closedTrades: payload.portfolio?.closed_trades || [],
    movements: payload.portfolio?.movements || [],
    portfolioSummary: payload.portfolio?.summary || base.portfolioSummary,
    portfolioSource: {
      asOf: payload.portfolio?.as_of,
      source: payload.portfolio?.source,
      ticketSize: payload.portfolio?.ticket_size,
      commissionPerSide: payload.portfolio?.commission_per_side,
      automation: payload.portfolio?.automation,
    },
    failed: payload.failed || [],
    meta: {
      mode: "api",
      generatedAt: payload.generated_at,
      latestMarketDate: payload.latest_market_date,
      universeSource: payload.universe_source,
      universeCount: payload.universe_count,
      downloadedCount: payload.downloaded_count,
      failedCount: payload.failed_count,
      elapsedMs: payload.elapsed_ms,
      dashboard: payload.dashboard,
      rules: payload.rules,
    },
  };
}
