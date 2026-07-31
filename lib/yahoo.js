// Cliente de Yahoo Finance chart API (publico, sin token).
// Extraido de lib/scanner.js y ampliado para devolver OHLC completo,
// necesario para simular stops y take profits en el motor de paper trading.

const { finite } = require("./indicators");

const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function yahooSymbol(symbol) {
  return String(symbol || "").trim().replace(/\./g, "-");
}

async function fetchText(url, timeoutMs = 15000) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response.text();
}

// Devuelve filas {date, open, high, low, close, volume}.
// `close` sigue siendo el cierre ajustado (como antes) y open/high/low se
// escalan con el mismo ratio de ajuste para que todo viva en la misma base:
// asi un split no descoloca un stop de una posicion abierta.
async function fetchChart(symbol, { range = "1y", timeoutMs = 15000 } = {}) {
  const url = `${YAHOO_CHART}${encodeURIComponent(symbol)}?range=${range}&interval=1d&events=history&includeAdjustedClose=true`;
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error(payload.chart?.error?.description || "sin result");
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose || [];
  const rows = [];

  for (let i = 0; i < timestamps.length; i += 1) {
    const rawClose = finite(quote.close?.[i]);
    const close = finite(adjusted[i], rawClose);
    const volume = finite(quote.volume?.[i], 0);
    if (!Number.isFinite(close)) continue;

    const ratio = Number.isFinite(rawClose) && rawClose !== 0 ? close / rawClose : 1;
    const open = finite(quote.open?.[i]);
    const high = finite(quote.high?.[i]);
    const low = finite(quote.low?.[i]);

    rows.push({
      date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
      open: Number.isFinite(open) ? open * ratio : close,
      high: Number.isFinite(high) ? high * ratio : close,
      low: Number.isFinite(low) ? low * ratio : close,
      close,
      volume,
    });
  }

  const regularPrice = finite(result.meta?.regularMarketPrice);
  const regularTime = finite(result.meta?.regularMarketTime);
  if (Number.isFinite(regularPrice) && Number.isFinite(regularTime) && rows.length) {
    const regularDate = new Date(regularTime * 1000).toISOString().slice(0, 10);
    const last = rows[rows.length - 1];
    if (last.date === regularDate) {
      last.close = regularPrice;
      last.high = Math.max(last.high, regularPrice);
      last.low = Math.min(last.low, regularPrice);
      if (Number.isFinite(result.meta?.regularMarketVolume)) last.volume = result.meta.regularMarketVolume;
    } else if (last.date < regularDate) {
      rows.push({
        date: regularDate,
        open: regularPrice,
        high: regularPrice,
        low: regularPrice,
        close: regularPrice,
        volume: finite(result.meta?.regularMarketVolume, 0),
      });
    }
  }

  return { symbol, rows, meta: result.meta || {} };
}

// Igual que fetchChart pero exige historial suficiente para SMA200 y compania.
async function fetchChartForScan(symbol, timeoutMs = 15000) {
  const chart = await fetchChart(symbol, { range: "1y", timeoutMs });
  if (chart.rows.length < 220) throw new Error(`historial insuficiente: ${chart.rows.length}`);
  return chart;
}

async function fetchCharts(symbols, concurrency = 24, fetcher = fetchChartForScan) {
  let cursor = 0;
  const ok = [];
  const failed = [];

  async function worker() {
    while (cursor < symbols.length) {
      const symbol = symbols[cursor];
      cursor += 1;
      try {
        ok.push(await fetcher(symbol));
      } catch (error) {
        failed.push({ symbol, error: error.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
  return { ok, failed };
}

module.exports = {
  YAHOO_CHART,
  USER_AGENT,
  yahooSymbol,
  fetchText,
  fetchChart,
  fetchChartForScan,
  fetchCharts,
};
