// Carga del universo S&P 500 desde Wikipedia con fallback estatico.
// Extraido de lib/scanner.js sin cambiar el comportamiento.

const FALLBACK_UNIVERSE = require("../data/sp500_fallback.json");
const NASDAQ100_FALLBACK_UNIVERSE = require("../data/nasdaq100_fallback.json");
const NYSE_FALLBACK_UNIVERSE = require("../data/nyse_fallback.json");
const { fetchText, yahooSymbol } = require("./yahoo");

const WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
const NASDAQ100_URL = "https://api.nasdaq.com/api/quote/list-type/nasdaq100";
const NYSE_SCREENER_URL = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&exchange=nyse&download=true";
const BENCHMARKS = ["SPY", "QQQ"];
const NYSE_EXCLUDED_INSTRUMENT_RE =
  /\b(preferred|depositary shares|warrants?|rights?|units?|notes?|bonds?|debentures?|etf|fund|closed[ -]?end|subordinated|senior notes?|series [a-z])\b/i;

function stripHtml(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSp500FromWikipedia(html) {
  const tableMatch = html.match(/<table[^>]+id=["']constituents["'][\s\S]*?<\/table>/i);
  if (!tableMatch) throw new Error("No encuentro tabla constituents en Wikipedia");
  const rows = [...tableMatch[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  const universe = [];

  for (const row of rows.slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripHtml(m[1]));
    if (cells.length < 4) continue;
    const ticker = yahooSymbol(cells[0]);
    if (!ticker) continue;
    universe.push({
      ticker,
      name: cells[1],
      gics_sector: cells[2],
      gics_sub_industry: cells[3],
    });
  }
  if (universe.length < 450) throw new Error(`Universo SP500 demasiado pequeno: ${universe.length}`);
  return universe;
}

async function loadUniverse() {
  try {
    const html = await fetchText(WIKI_URL);
    return { universe: parseSp500FromWikipedia(html), source: "wikipedia" };
  } catch (error) {
    return { universe: FALLBACK_UNIVERSE, source: `fallback (${error.message})` };
  }
}

function cleanNasdaqName(value) {
  return String(value || "")
    .replace(/\b(Common Stock|Ordinary Shares|American Depositary Shares|ADS|ADR)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanNyseName(value) {
  return String(value || "")
    .replace(/\b(Common Stock|Ordinary Shares|Common Shares|Class A Common Stock|Class B Common Stock)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNyseCommonStock(row) {
  const symbol = String(row?.symbol || "");
  return (
    Boolean(row?.symbol && row?.name) &&
    !/[\^/]/.test(symbol) &&
    !NYSE_EXCLUDED_INSTRUMENT_RE.test(row.name)
  );
}

function parseNasdaq100FromApi(payload) {
  const rows = payload?.data?.data?.rows;
  if (!Array.isArray(rows)) throw new Error("Respuesta Nasdaq-100 sin filas");

  const universe = rows
    .map((row) => {
      const ticker = yahooSymbol(row.symbol);
      if (!ticker) return null;
      return {
        ticker,
        name: cleanNasdaqName(row.companyName) || ticker,
        gics_sector: row.sector || "Nasdaq-100",
        gics_sub_industry: "Nasdaq-100",
      };
    })
    .filter(Boolean);

  if (universe.length < 80) throw new Error(`Universo Nasdaq-100 demasiado pequeno: ${universe.length}`);
  return universe;
}

function parseNyseFromApi(payload) {
  const rows = payload?.data?.rows;
  if (!Array.isArray(rows)) throw new Error("Respuesta NYSE sin filas");

  const universe = rows
    .filter(isNyseCommonStock)
    .map((row) => {
      const ticker = yahooSymbol(row.symbol);
      if (!ticker) return null;
      return {
        ticker,
        name: cleanNyseName(row.name) || ticker,
        gics_sector: row.sector || "NYSE",
        gics_sub_industry: row.industry || "NYSE",
      };
    })
    .filter(Boolean);

  if (universe.length < 1000) throw new Error(`Universo NYSE demasiado pequeno: ${universe.length}`);
  return universe;
}

async function fetchJson(url, timeoutMs = 15000) {
  const text = await fetchText(url, timeoutMs);
  return JSON.parse(text);
}

async function loadNasdaq100Universe() {
  try {
    const payload = await fetchJson(NASDAQ100_URL);
    return { universe: parseNasdaq100FromApi(payload), source: "nasdaq-api" };
  } catch (error) {
    return { universe: NASDAQ100_FALLBACK_UNIVERSE, source: `nasdaq100_fallback (${error.message})` };
  }
}

async function loadNyseUniverse() {
  try {
    const payload = await fetchJson(NYSE_SCREENER_URL);
    return { universe: parseNyseFromApi(payload), source: "nyse-nasdaq-screener" };
  } catch (error) {
    return { universe: NYSE_FALLBACK_UNIVERSE, source: `nyse_fallback (${error.message})` };
  }
}

function mergeUniverses(primary, secondary) {
  const byTicker = new Map();
  for (const row of [...primary, ...secondary]) {
    const ticker = yahooSymbol(row.ticker);
    if (!ticker || byTicker.has(ticker)) continue;
    byTicker.set(ticker, { ...row, ticker });
  }
  return [...byTicker.values()];
}

async function loadSp500Nasdaq100Universe() {
  const [sp500, nasdaq100] = await Promise.all([loadUniverse(), loadNasdaq100Universe()]);
  const universe = mergeUniverses(sp500.universe, nasdaq100.universe);
  return {
    universe,
    source: `${sp500.source} + ${nasdaq100.source}`,
    sp500_count: sp500.universe.length,
    nasdaq100_count: nasdaq100.universe.length,
    overlap_count: sp500.universe.length + nasdaq100.universe.length - universe.length,
  };
}

async function loadSp500NasdaqNyseUniverse() {
  const [sp500, nasdaq100, nyse] = await Promise.all([loadUniverse(), loadNasdaq100Universe(), loadNyseUniverse()]);
  const sp500Nasdaq = mergeUniverses(sp500.universe, nasdaq100.universe);
  const universe = mergeUniverses(sp500Nasdaq, nyse.universe);
  return {
    universe,
    source: `${sp500.source} + ${nasdaq100.source} + ${nyse.source}`,
    sp500_count: sp500.universe.length,
    nasdaq100_count: nasdaq100.universe.length,
    nyse_count: nyse.universe.length,
    overlap_count: sp500.universe.length + nasdaq100.universe.length + nyse.universe.length - universe.length,
  };
}

module.exports = {
  WIKI_URL,
  NASDAQ100_URL,
  NYSE_SCREENER_URL,
  NYSE_EXCLUDED_INSTRUMENT_RE,
  BENCHMARKS,
  FALLBACK_UNIVERSE,
  NASDAQ100_FALLBACK_UNIVERSE,
  NYSE_FALLBACK_UNIVERSE,
  stripHtml,
  parseSp500FromWikipedia,
  parseNasdaq100FromApi,
  parseNyseFromApi,
  loadNasdaq100Universe,
  loadNyseUniverse,
  loadSp500Nasdaq100Universe,
  loadSp500NasdaqNyseUniverse,
  mergeUniverses,
  loadUniverse,
};
