// Motor de paper trading.
//
// No es un backtest: no reproduce el pasado. Cada dia que corre el tracker
// toma las senales de ese dia, abre posiciones ficticias y marca a mercado las
// que ya estaban abiertas. El historial se construye hacia delante, asi que
// todo lo que mide es out-of-sample por construccion.
//
// El motor es identico para todas las estrategias: lo unico que cambia es que
// senales le llegan.

// Comision + horquilla estimadas por operacion (ida). Sin esto el paper
// trading exagera el rendimiento de las estrategias que rotan mas.
const COST_PER_SIDE_PCT = 0.0005;

// En las velas de lib/yahoo.js `close` viene ajustado por dividendos y splits,
// mientras que high/low son precios reales. Mezclarlos haria que un stop se
// comparase contra dos bases distintas, asi que la simulacion usa siempre el
// cierre sin ajustar.
function closeOf(row) {
  return Number.isFinite(row?.close_raw) ? row.close_raw : row?.close;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function dayDiff(a, b) {
  return Math.round((new Date(a) - new Date(b)) / 86400000);
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

// Busca la fila de precio de una fecha concreta, o la ultima disponible.
function rowFor(chart, date) {
  if (!chart?.rows?.length) return null;
  const exact = chart.rows.find((row) => row.date === date);
  return exact || chart.rows[chart.rows.length - 1];
}

function rowsAfter(chart, date) {
  if (!chart?.rows?.length) return [];
  return chart.rows.filter((row) => row.date > date);
}

// Cierra una posicion y devuelve el registro del trade.
function closePosition(position, exitDate, exitPrice, reason) {
  const grossProceeds = position.qty * exitPrice;
  const costs = grossProceeds * COST_PER_SIDE_PCT;
  const proceeds = grossProceeds - costs;
  const pnl = proceeds - position.cost_basis;
  const pnlPct = position.cost_basis > 0 ? pnl / position.cost_basis : 0;
  // R multiple: cuantas veces el riesgo inicial se ha ganado o perdido.
  const riskPerShare = position.entry_price - position.stop_price;
  const r = riskPerShare > 0 ? (exitPrice - position.entry_price) / riskPerShare : null;

  return {
    ticker: position.ticker,
    name: position.name,
    sector: position.sector,
    family: position.family,
    entry_date: position.entry_date,
    entry_price: round(position.entry_price, 4),
    exit_date: exitDate,
    exit_price: round(exitPrice, 4),
    exit_reason: reason,
    qty: round(position.qty, 6),
    cost_basis: round(position.cost_basis, 2),
    proceeds: round(proceeds, 2),
    pnl: round(pnl, 2),
    pnl_pct: round(pnlPct, 6),
    r_multiple: round(r, 3),
    hold_days: dayDiff(exitDate, position.entry_date),
    stop_price: round(position.stop_price, 4),
    target_price: round(position.target_price, 4),
    signal_meta: position.signal_meta || null,
  };
}

// Marca a mercado las posiciones abiertas y cierra las que han tocado stop,
// objetivo o el limite de dias.
//
// Si un dia toca stop Y objetivo, se asume el stop. Con velas diarias no se
// sabe cual llego antes, y suponer lo peor evita inflar los resultados.
function updateOpenPositions(state, chartsByTicker, workspace, marketDate) {
  const stillOpen = [];
  const closed = [];

  for (const position of state.positions) {
    const chart = chartsByTicker.get(position.ticker);
    if (!chart) {
      stillOpen.push(position);
      continue;
    }

    const newRows = rowsAfter(chart, position.last_marked_date || position.entry_date);
    let exit = null;

    for (const row of newRows) {
      const hitStop = row.low <= position.stop_price;
      const hitTarget = row.high >= position.target_price;

      if (hitStop) {
        exit = { date: row.date, price: position.stop_price, reason: hitTarget ? "STOP_MISMO_DIA_QUE_TP" : "STOP" };
        break;
      }
      if (hitTarget) {
        exit = { date: row.date, price: position.target_price, reason: "OBJETIVO" };
        break;
      }
      if (dayDiff(row.date, position.entry_date) >= workspace.portfolio.max_hold_days) {
        exit = { date: row.date, price: closeOf(row), reason: "LIMITE_DIAS" };
        break;
      }
    }

    if (exit) {
      const trade = closePosition(position, exit.date, exit.price, exit.reason);
      closed.push(trade);
      state.cash += trade.proceeds;
      continue;
    }

    const lastRow = rowFor(chart, marketDate);
    if (lastRow) {
      const marked = closeOf(lastRow);
      position.last_price = round(marked, 4);
      position.last_marked_date = lastRow.date;
      position.unrealized_pnl = round(position.qty * marked - position.cost_basis, 2);
      position.unrealized_pct = round((marked / position.entry_price - 1), 6);
    }
    stillOpen.push(position);
  }

  state.positions = stillOpen;
  state.trades.push(...closed);
  return closed;
}

function mergeInsiderTiming(currentInsiders, latestInsiders) {
  if (!Array.isArray(currentInsiders) || !Array.isArray(latestInsiders)) return currentInsiders;
  return currentInsiders.map((current) => {
    if (current.filing_datetime) return current;
    const latest = latestInsiders.find((candidate) => {
      const sameSource = (candidate.source || "") === (current.source || "");
      const sameDate = candidate.date === current.date;
      const sameName = String(candidate.name || "").toUpperCase() === String(current.name || "").toUpperCase();
      return sameSource && sameDate && sameName;
    });
    return latest?.filing_datetime ? { ...current, filing_datetime: latest.filing_datetime } : current;
  });
}

function mergeMissingSignalTiming(currentMeta, latestMeta) {
  if (!latestMeta) return currentMeta || null;
  if (!currentMeta) return latestMeta;

  const merged = { ...currentMeta };
  for (const field of [
    "first_filing",
    "last_filing",
    "first_filing_datetime",
    "last_filing_datetime",
    "conviction_filing_date",
  ]) {
    if (!merged[field] && latestMeta[field]) merged[field] = latestMeta[field];
  }
  if (Array.isArray(merged.insiders)) {
    merged.insiders = mergeInsiderTiming(merged.insiders, latestMeta.insiders);
  }
  return merged;
}

function comparableDate(value) {
  if (!value) return null;
  const text = String(value);
  const isoDate = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  return isoDate || null;
}

function latestDate(values) {
  return values.map(comparableDate).filter(Boolean).sort().at(-1) || null;
}

function insiderEventDateFromMeta(meta = {}) {
  const insiders = Array.isArray(meta.insiders) ? meta.insiders : [];
  return latestDate([
    meta.conviction_filing_date,
    meta.last_filing_datetime,
    meta.last_filing,
    meta.dataroma_flow?.latest_filing_date,
    ...insiders.map((row) => row.filing_datetime),
    ...insiders.map((row) => row.filing_date),
    // Fallback por si una fuente trae solo fecha de transaccion. Para las
    // fuentes actuales normalmente gana la fecha de publicacion/filing.
    meta.last_buy,
    meta.dataroma_flow?.last_purchase,
    ...insiders.map((row) => row.date),
  ]);
}

function insiderEventDateFromSignal(signal = {}) {
  return insiderEventDateFromMeta(signal.meta || {});
}

function latestTradeForTicker(trades = [], ticker, beforeOrAtEntryDate = null) {
  return trades
    .filter((trade) => trade.ticker === ticker)
    .filter((trade) => !beforeOrAtEntryDate || !trade.exit_date || trade.exit_date <= beforeOrAtEntryDate)
    .sort((a, b) => String(a.exit_date || "").localeCompare(String(b.exit_date || "")))
    .at(-1) || null;
}

function reentryBlock(signal, state, workspace) {
  if (!workspace?.portfolio?.require_new_insider_event_after_exit) return null;
  const lastTrade = latestTradeForTicker(state.trades || [], signal.ticker);
  if (!lastTrade?.exit_date) return null;

  const eventDate = insiderEventDateFromSignal(signal);
  if (eventDate && eventDate > lastTrade.exit_date) return null;

  return {
    ticker: signal.ticker,
    last_exit_date: lastTrade.exit_date,
    last_exit_reason: lastTrade.exit_reason,
    signal_event_date: eventDate,
    reason: eventDate
      ? `sin compras/filings insider posteriores al cierre ${lastTrade.exit_date}`
      : `sin fecha de publicacion insider posterior al cierre ${lastTrade.exit_date}`,
  };
}

function blockSignalReentry(signal, block) {
  signal.authorized = false;
  signal.action = "ESPERAR_NUEVO_INSIDER";
  signal.size_pct = 0;
  signal.reason = `${signal.reason} | reentrada bloqueada: ${block.reason}`;
  signal.meta = {
    ...(signal.meta || {}),
    reentry_blocked: true,
    reentry_block_reason: block.reason,
    reentry_last_exit_date: block.last_exit_date,
    reentry_signal_event_date: block.signal_event_date,
  };
}

function refreshOpenSignalMetadata(state, signals) {
  const latestByTicker = new Map((signals || []).map((signal) => [signal.ticker, signal.meta]));
  for (const position of state.positions) {
    position.signal_meta = mergeMissingSignalTiming(position.signal_meta, latestByTicker.get(position.ticker));
  }
}

function pruneInvalidReopenedPositions(state, workspace) {
  if (!workspace?.portfolio?.require_new_insider_event_after_exit) return [];

  const kept = [];
  const pruned = [];
  for (const position of state.positions) {
    const lastTrade = latestTradeForTicker(state.trades || [], position.ticker, position.entry_date);
    if (!lastTrade?.exit_date) {
      kept.push(position);
      continue;
    }

    const eventDate = insiderEventDateFromMeta(position.signal_meta || {});
    if (eventDate && eventDate > lastTrade.exit_date) {
      kept.push(position);
      continue;
    }

    state.cash += position.cost_basis || 0;
    pruned.push({
      ticker: position.ticker,
      entry_date: position.entry_date,
      last_exit_date: lastTrade.exit_date,
      signal_event_date: eventDate,
      refunded_cost_basis: round(position.cost_basis, 2),
    });
  }

  state.positions = kept;
  return pruned;
}

// Abre posiciones nuevas a partir de las senales autorizadas de hoy.
function openNewPositions(state, signals, chartsByTicker, workspace, marketDate, blockedReentries = []) {
  const opened = [];
  const cfg = workspace.portfolio;
  const openTickers = new Set(state.positions.map((p) => p.ticker));

  const sectorCounts = new Map();
  for (const position of state.positions) {
    const sector = position.sector || "SIN_SECTOR";
    sectorCounts.set(sector, (sectorCounts.get(sector) || 0) + 1);
  }

  const equity = currentEquity(state);
  const candidates = signals.filter((s) => s.authorized && !openTickers.has(s.ticker));

  for (const signal of candidates) {
    if (opened.length >= cfg.max_new_positions_per_day) break;
    if (state.positions.length >= cfg.max_open_positions) break;

    const block = reentryBlock(signal, state, workspace);
    if (block) {
      blockSignalReentry(signal, block);
      blockedReentries.push(block);
      continue;
    }

    const sector = signal.sector || "SIN_SECTOR";
    if ((sectorCounts.get(sector) || 0) >= cfg.max_positions_per_sector) continue;

    const chart = chartsByTicker.get(signal.ticker);
    const row = rowFor(chart, marketDate);
    if (!row || !Number.isFinite(closeOf(row))) continue;

    // Se entra al cierre del dia de la senal. Es la ejecucion mas conservadora
    // que permite un tracker diario: no se puede suponer un precio mejor.
    const entryPrice = closeOf(row);
    // No perseguir: si el precio ya se fue por encima de la zona, no se entra.
    if (Number.isFinite(signal.entry_zone_high) && entryPrice > signal.entry_zone_high) continue;

    const sizePct = Number.isFinite(signal.size_pct) && signal.size_pct > 0 ? signal.size_pct : 0.05;
    const targetNotional = equity * sizePct;
    if (targetNotional <= 0) continue;

    const grossCost = Math.min(targetNotional, state.cash);
    if (grossCost < 100) continue;

    const qty = grossCost / (entryPrice * (1 + COST_PER_SIDE_PCT));
    const costBasis = qty * entryPrice * (1 + COST_PER_SIDE_PCT);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    state.cash -= costBasis;
    const position = {
      ticker: signal.ticker,
      name: signal.name,
      sector: signal.sector,
      family: signal.family,
      entry_date: marketDate,
      entry_price: round(entryPrice, 4),
      qty: round(qty, 6),
      cost_basis: round(costBasis, 2),
      stop_price: round(signal.invalid_below_price, 4),
      target_price: round(signal.target_price, 4),
      last_price: round(entryPrice, 4),
      last_marked_date: marketDate,
      unrealized_pnl: 0,
      unrealized_pct: 0,
      signal_event_date: insiderEventDateFromSignal(signal),
      signal_meta: signal.meta || null,
    };

    state.positions.push(position);
    sectorCounts.set(sector, (sectorCounts.get(sector) || 0) + 1);
    opened.push(position);
  }

  return opened;
}

function currentEquity(state) {
  const positionsValue = state.positions.reduce((sum, p) => sum + p.qty * (p.last_price || p.entry_price), 0);
  return state.cash + positionsValue;
}

function upsertEquityCurveRow(state, row) {
  const existingIndex = state.equity_curve.findIndex((point) => point.date === row.date);
  if (existingIndex >= 0) state.equity_curve[existingIndex] = row;
  else state.equity_curve.push(row);
}

// Un ciclo completo de tracking para un workspace.
function trackDay(state, { signals, charts, marketDate, workspace }) {
  const date = marketDate || todayISO();
  const chartsByTicker = new Map((charts || []).map((chart) => [chart.symbol, chart]));

  if (state.last_market_date && date < state.last_market_date) {
    return {
      skipped: true,
      reason: `El dia ${date} es anterior al ultimo procesado (${state.last_market_date})`,
      closed: [],
      opened: [],
      equity: currentEquity(state),
    };
  }

  const sameDayUpdate = Boolean(state.last_market_date && date === state.last_market_date);
  const prunedReentries = pruneInvalidReopenedPositions(state, workspace);
  refreshOpenSignalMetadata(state, signals || []);
  const closed = updateOpenPositions(state, chartsByTicker, workspace, date);
  const blockedReentries = [];
  const opened = openNewPositions(state, signals || [], chartsByTicker, workspace, date, blockedReentries);

  const equity = currentEquity(state);
  upsertEquityCurveRow(state, {
    date,
    equity: round(equity, 2),
    cash: round(state.cash, 2),
    open_positions: state.positions.length,
  });
  if (!sameDayUpdate) state.tracked_days += 1;
  state.last_market_date = date;
  state.updated_at = new Date().toISOString();

  return {
    skipped: false,
    same_day_update: sameDayUpdate,
    closed,
    opened,
    equity,
    blocked_reentries: blockedReentries,
    pruned_reentries: prunedReentries,
  };
}

module.exports = {
  COST_PER_SIDE_PCT,
  trackDay,
  currentEquity,
  updateOpenPositions,
  openNewPositions,
  refreshOpenSignalMetadata,
  insiderEventDateFromMeta,
  reentryBlock,
  pruneInvalidReopenedPositions,
  closePosition,
  todayISO,
};
