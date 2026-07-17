const portfolioData = require("../data/portfolio.json");

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 2) {
  const n = finite(value, 0);
  return Number(n.toFixed(digits));
}

function sharesFor(trade) {
  if (Number.isFinite(Number(trade.shares))) return Number(trade.shares);
  const ticket = finite(trade.ticket_size, portfolioData.ticket_size || 2000);
  const entry = finite(trade.entry, 0);
  return entry > 0 ? Math.floor(ticket / entry) : 0;
}

function businessSessionsBetween(startDate, endDate) {
  if (!startDate || !endDate || startDate >= endDate) return 0;
  const cursor = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  let sessions = 0;
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) sessions += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return sessions;
}

function latestPriceMap(rawRows) {
  const map = new Map();
  for (const row of rawRows || []) {
    if (!row?.ticker) continue;
    map.set(row.ticker, {
      price: finite(row.price, null),
      date: row.run_date || null,
      name: row.name,
      sector: row.gics_sector,
      history: row.history || [],
    });
  }
  return map;
}

function findExitTrigger(position, quote, asOfDate) {
  const history = (quote.history || [])
    .filter((row) => row.date > position.entry_date && row.date <= asOfDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!quote.date && !history.length) return null;

  for (const row of history) {
    const low = finite(row.low, finite(row.close, null));
    const high = finite(row.high, finite(row.close, null));
    const stopHit = Number.isFinite(low) && low <= position.stop;
    const targetHit = Number.isFinite(high) && high >= position.target;

    if (stopHit || targetHit) {
      const result = stopHit ? "STOP" : "TP";
      return {
        result,
        exit_date: row.date,
        exit: stopHit ? position.stop : position.target,
        note: stopHit
          ? `Cierre automatico: minimo diario ${round(low, 4)} toco stop ${round(position.stop, 4)}.`
          : `Cierre automatico: maximo diario ${round(high, 4)} toco objetivo ${round(position.target, 4)}.`,
      };
    }
  }

  const sessionsHeld = businessSessionsBetween(position.entry_date, asOfDate);
  if (position.max_sessions && sessionsHeld >= position.max_sessions) {
    return {
      result: "TIME_EXIT",
      exit_date: asOfDate,
      exit: finite(quote.price, position.entry),
      note: `Cierre automatico: alcanzo ${sessionsHeld}/${position.max_sessions} sesiones maximas.`,
    };
  }

  return null;
}

function enrichOpenPosition(position, prices, asOfDate) {
  const quote = prices.get(position.ticker) || {};
  const shares = sharesFor(position);
  const current = finite(quote.price, finite(position.current, position.entry));
  const commissionIn = finite(position.commission_in, portfolioData.commission_per_side || 0);
  const commissionOut = finite(position.commission_out, portfolioData.commission_per_side || 0);
  const invested = position.entry * shares + commissionIn;
  const marketValue = current * shares;
  const grossPnl = (current - position.entry) * shares;
  const pnl = grossPnl - commissionIn - commissionOut;
  const stopRisk = Math.max(0, (current - position.stop) * shares);
  const targetUpside = Math.max(0, (position.target - current) * shares);

  return {
    ticker: position.ticker,
    name: quote.name || position.name || position.ticker,
    sector: quote.sector || position.sector || "Sin sector",
    strategy: position.strategy || "SCANNER",
    entry_date: position.entry_date,
    quote_date: quote.date || asOfDate,
    shares,
    entry: round(position.entry, 4),
    current: round(current, 4),
    stop: round(position.stop, 4),
    target: round(position.target, 4),
    invested: round(invested),
    market_value: round(marketValue),
    pnl: round(pnl),
    pnl_pct: invested > 0 ? round((pnl / invested) * 100, 2) : 0,
    stop_risk: round(stopRisk),
    target_upside: round(targetUpside),
    sessions_held: businessSessionsBetween(position.entry_date, asOfDate),
    max_sessions: position.max_sessions || 15,
    note: position.note || "",
  };
}

function enrichClosedTrade(trade) {
  const shares = sharesFor(trade);
  const commissionIn = finite(trade.commission_in, portfolioData.commission_per_side || 0);
  const commissionOut = finite(trade.commission_out, portfolioData.commission_per_side || 0);
  const invested = trade.entry * shares + commissionIn;
  const pnl = (trade.exit - trade.entry) * shares - commissionIn - commissionOut;

  return {
    ticker: trade.ticker,
    name: trade.name || trade.ticker,
    sector: trade.sector || "Sin sector",
    strategy: trade.strategy || "SCANNER",
    entry_date: trade.entry_date,
    exit_date: trade.exit_date,
    shares,
    entry: round(trade.entry, 4),
    exit: round(trade.exit, 4),
    result: trade.result || "CERRADA",
    pnl: round(pnl),
    pnl_pct: invested > 0 ? round((pnl / invested) * 100, 2) : 0,
    sessions_held: businessSessionsBetween(trade.entry_date, trade.exit_date),
    auto_closed: Boolean(trade.auto_closed),
    note: trade.note || "",
  };
}

function autoClosePosition(position, trigger) {
  return enrichClosedTrade({
    ticker: position.ticker,
    name: position.name,
    sector: position.sector,
    strategy: position.strategy,
    entry_date: position.entry_date,
    exit_date: trigger.exit_date,
    entry: position.entry,
    exit: trigger.exit,
    result: trigger.result,
    shares: sharesFor(position),
    note: trigger.note,
    auto_closed: true,
  });
}

function summarize(openPositions, closedTrades) {
  const marketValue = openPositions.reduce((acc, row) => acc + row.market_value, 0);
  const invested = openPositions.reduce((acc, row) => acc + row.invested, 0);
  const openPnl = openPositions.reduce((acc, row) => acc + row.pnl, 0);
  const stopRisk = openPositions.reduce((acc, row) => acc + row.stop_risk, 0);
  const targetUpside = openPositions.reduce((acc, row) => acc + row.target_upside, 0);
  const closedPnl = closedTrades.reduce((acc, row) => acc + row.pnl, 0);
  const wins = closedTrades.filter((row) => row.pnl > 0).length;

  return {
    open_positions: openPositions.length,
    market_value: round(marketValue),
    invested: round(invested),
    open_pnl: round(openPnl),
    open_pnl_pct: invested > 0 ? round((openPnl / invested) * 100, 2) : 0,
    stop_risk: round(stopRisk),
    target_upside: round(targetUpside),
    closed_trades: closedTrades.length,
    closed_pnl: round(closedPnl),
    win_rate: closedTrades.length ? round((wins / closedTrades.length) * 100, 1) : 0,
    total_pnl: round(openPnl + closedPnl),
  };
}

function buildPortfolioSnapshot(rawRows = [], asOfDate = portfolioData.as_of) {
  const prices = latestPriceMap(rawRows);
  const asOf = asOfDate || portfolioData.as_of;
  const openPositions = [];
  const autoClosedTrades = [];

  for (const position of portfolioData.open_positions || []) {
    const quote = prices.get(position.ticker) || {};
    const trigger = findExitTrigger(position, quote, asOf);
    if (trigger) autoClosedTrades.push(autoClosePosition(position, trigger));
    else openPositions.push(enrichOpenPosition(position, prices, asOf));
  }

  const closedTrades = (portfolioData.closed_trades || []).map(enrichClosedTrade).concat(autoClosedTrades);

  return {
    as_of: asOf,
    source: portfolioData.source,
    ticket_size: portfolioData.ticket_size,
    commission_per_side: portfolioData.commission_per_side,
    automation: {
      mode: "stateless_yahoo_rules",
      auto_closed_count: autoClosedTrades.length,
      note: "La API deriva cierres por stop, take profit o tiempo maximo usando historico Yahoo; no escribe en disco en Vercel.",
    },
    open_positions: openPositions,
    closed_trades: closedTrades,
    summary: summarize(openPositions, closedTrades),
  };
}

function scannerContextFromPortfolio(snapshot) {
  const openTickers = new Set((snapshot.open_positions || []).map((row) => row.ticker));
  const allTrades = [
    ...(portfolioData.open_positions || []),
    ...(portfolioData.closed_trades || []),
  ];
  const buysToday = allTrades.filter((row) => row.entry_date === snapshot.as_of);
  const sectorBuysToday = {};
  for (const row of buysToday) {
    const sector = row.sector || "SIN_SECTOR";
    sectorBuysToday[sector] = (sectorBuysToday[sector] || 0) + 1;
  }

  return {
    openTickers,
    buysTodayCount: buysToday.length,
    sectorBuysToday,
  };
}

module.exports = {
  buildPortfolioSnapshot,
  scannerContextFromPortfolio,
};
