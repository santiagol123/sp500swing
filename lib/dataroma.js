// Cliente ligero para la tabla publica de insider transactions de Dataroma.
// Se usa solo en el tracker/Action; Vercel sigue sirviendo snapshots.

const { USER_AGENT, yahooSymbol } = require("./yahoo");

const DATAROMA_INSIDER_URL = "https://dataroma.com/m/ins/ins.php";
const DEFAULT_TIMEFRAME = process.env.DATAROMA_TIMEFRAME || "y";
const DEFAULT_MAX_PAGES = Number(process.env.DATAROMA_MAX_PAGES || 25);

const MONTHS = new Map([
  ["jan", "01"],
  ["feb", "02"],
  ["mar", "03"],
  ["apr", "04"],
  ["may", "05"],
  ["jun", "06"],
  ["jul", "07"],
  ["aug", "08"],
  ["sep", "09"],
  ["oct", "10"],
  ["nov", "11"],
  ["dec", "12"],
]);

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtml(value) {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(value) {
  const text = stripHtml(value).replace(/\$/g, "").replace(/,/g, "").trim();
  if (!text || text === "-") return null;
  const negative = /^\(.*\)$/.test(text);
  const n = Number(text.replace(/[()]/g, ""));
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

function parseDate(value) {
  const text = stripHtml(value);
  const match = text.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (!match) return null;
  const month = MONTHS.get(match[2].toLowerCase());
  if (!month) return null;
  return `${match[3]}-${month}-${String(match[1]).padStart(2, "0")}`;
}

function parseHref(value) {
  const match = String(value || "").match(/href=["']([^"']+)["']/i);
  if (!match) return null;
  if (match[1].startsWith("http")) return decodeEntities(match[1]);
  return `https://dataroma.com${decodeEntities(match[1])}`;
}

function parseReportingOwnerId(value) {
  const href = parseHref(value);
  if (!href) return null;
  const match = href.match(/[?&]rid=(\d+)/);
  return match ? match[1] : null;
}

function relationFlags(relationship) {
  const rel = stripHtml(relationship);
  const lower = rel.toLowerCase();
  return {
    title: rel || "Insider",
    is_officer: /officer|chief|ceo|cfo|coo|president|vp|executive|treasurer|secretary/i.test(lower),
    is_director: /director|chairman|chair/i.test(lower),
    is_ten_percent_owner: /10%|beneficial owner/i.test(lower),
  };
}

function rowKey(row) {
  return [
    row.symbol,
    String(row.owner_name || "").toUpperCase().replace(/\s+/g, " "),
    row.transaction_date || row.filing_date || "",
    Math.round(Number(row.shares || 0)),
    Math.round(Number(row.value_usd || 0)),
  ].join("|");
}

function normalizeUniverseTickers(universeTickers) {
  if (!universeTickers) return null;
  return new Set([...universeTickers].map((ticker) => yahooSymbol(ticker).toUpperCase()));
}

function parseDataromaRows(html, { sinceDate = null, universeTickers = null } = {}) {
  const allowed = normalizeUniverseTickers(universeTickers);
  const rows = [];
  const seen = new Set();
  const trMatches = String(html || "").match(/<tr[^>]*class=["'][^"']*col[12][^"']*["'][^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const tr of trMatches) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 11) continue;

    const transactionType = stripHtml(cells[6]);
    if (!/purchase/i.test(transactionType)) continue;

    const symbol = yahooSymbol(stripHtml(cells[1])).toUpperCase();
    if (!symbol || (allowed && !allowed.has(symbol))) continue;

    const transactionDate = parseDate(cells[5]) || parseDate(cells[0]);
    const filingDate = parseDate(cells[0]) || transactionDate;
    if (sinceDate && transactionDate && transactionDate < sinceDate) continue;

    const shares = parseNumber(cells[7]);
    const price = parseNumber(cells[8]);
    const amount = parseNumber(cells[9]);
    const value = Number.isFinite(amount) ? amount : Number.isFinite(shares) && Number.isFinite(price) ? shares * price : null;
    if (!Number.isFinite(value) || value <= 0) continue;

    const flags = relationFlags(cells[4]);
    const row = {
      source: "dataroma",
      symbol,
      issuer_name: stripHtml(cells[2]),
      filing_date: filingDate,
      transaction_date: transactionDate,
      owner_cik: parseReportingOwnerId(cells[3]),
      owner_name: stripHtml(cells[3]),
      owner_title: flags.title,
      is_officer: flags.is_officer,
      is_director: flags.is_director,
      is_ten_percent_owner: flags.is_ten_percent_owner,
      shares: Number.isFinite(shares) ? shares : 0,
      price: Number.isFinite(price) ? price : null,
      value_usd: value,
      direct_indirect: stripHtml(cells[10]),
      filing_url: parseHref(cells[0]),
    };

    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }

  return rows;
}

function dataromaPageUrl({ page = 1, timeframe = DEFAULT_TIMEFRAME } = {}) {
  const params = new URLSearchParams({
    L: String(page),
    po: "1",
    t: timeframe,
  });
  return `${DATAROMA_INSIDER_URL}?${params.toString()}`;
}

async function fetchDataromaPage(url, timeoutMs = 20000) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      referer: DATAROMA_INSIDER_URL,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = new TextDecoder("iso-8859-1").decode(await response.arrayBuffer());
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return text;
}

async function fetchDataromaInsiderBuys({
  lookbackDays = 90,
  maxPages = DEFAULT_MAX_PAGES,
  timeframe = DEFAULT_TIMEFRAME,
  universeTickers = null,
  timeoutMs = 20000,
} = {}) {
  const sinceDate = daysAgo(lookbackDays);
  const rows = [];
  const seen = new Set();
  const pages = [];
  let rawRows = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = dataromaPageUrl({ page, timeframe });
    const html = await fetchDataromaPage(url, timeoutMs);
    const pageAllRows = parseDataromaRows(html);
    const pageRows = parseDataromaRows(html, { sinceDate, universeTickers });
    rawRows += pageAllRows.length;

    for (const row of pageRows) {
      const key = rowKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }

    const dates = pageAllRows.map((row) => row.transaction_date).filter(Boolean).sort();
    const newest = dates.at(-1) || null;
    const oldest = dates[0] || null;
    pages.push({ page, url, raw_rows: pageAllRows.length, rows_after_filters: pageRows.length, newest, oldest });

    if (!pageAllRows.length) break;
    if (oldest && oldest < sinceDate && !pageAllRows.some((row) => row.transaction_date >= sinceDate)) break;
  }

  return {
    rows,
    stats: {
      dataroma_url: DATAROMA_INSIDER_URL,
      dataroma_timeframe: timeframe,
      dataroma_since_date: sinceDate,
      dataroma_pages_fetched: pages.length,
      dataroma_rows_raw: rawRows,
      dataroma_rows_after_filters: rows.length,
      dataroma_pages: pages,
    },
  };
}

module.exports = {
  DATAROMA_INSIDER_URL,
  parseDate,
  parseNumber,
  parseDataromaRows,
  fetchDataromaPage,
  fetchDataromaInsiderBuys,
};
