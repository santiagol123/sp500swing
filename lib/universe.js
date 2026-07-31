// Carga del universo S&P 500 desde Wikipedia con fallback estatico.
// Extraido de lib/scanner.js sin cambiar el comportamiento.

const FALLBACK_UNIVERSE = require("../data/sp500_fallback.json");
const { fetchText, yahooSymbol } = require("./yahoo");

const WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
const BENCHMARKS = ["SPY", "QQQ"];

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

module.exports = {
  WIKI_URL,
  BENCHMARKS,
  FALLBACK_UNIVERSE,
  stripHtml,
  parseSp500FromWikipedia,
  loadUniverse,
};
