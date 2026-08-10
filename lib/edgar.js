// Cliente de SEC EDGAR para formularios 4 (operaciones de insiders).
// Gratis y sin token, pero la SEC exige:
//   - User-Agent identificable con contacto real
//   - maximo 10 peticiones por segundo
// https://www.sec.gov/os/accessing-edgar-data

const SUBMISSIONS = "https://data.sec.gov/submissions/CIK";
const ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

// La SEC rechaza peticiones sin contacto. Se puede sobreescribir por entorno.
const SEC_USER_AGENT =
  process.env.SEC_USER_AGENT || "sp500swing paper-trading research danielsilvaiglesias@gmail.com";

const MAX_REQUESTS_PER_SECOND = Number(process.env.SEC_RPS || 8);

// Codigos de transaccion del formulario 4 que representan compra voluntaria
// en mercado abierto. "P" es la unica que refleja conviccion real: "A" son
// concesiones de la empresa y "M" ejercicios de opciones, que no cuentan.
const OPEN_MARKET_BUY = "P";

let lastSlot = 0;
async function throttle() {
  const gap = 1000 / MAX_REQUESTS_PER_SECOND;
  const now = Date.now();
  const wait = Math.max(0, lastSlot + gap - now);
  lastSlot = now + wait;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

async function secFetch(url, { json = false, timeoutMs = 20000, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await throttle();
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": SEC_USER_AGENT,
          accept: json ? "application/json" : "*/*",
          "accept-encoding": "gzip, deflate",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) return null;
      if (response.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return json ? response.json() : response.text();
    } catch (error) {
      if (attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  return null;
}

function padCik(cik) {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

// Devuelve el contenido de <tag>, resolviendo el <value> anidado que usan los
// campos numericos del formulario 4.
function tagText(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!match) return null;
  const inner = match[1];
  const valueMatch = inner.match(/<value>([\s\S]*?)<\/value>/);
  const text = (valueMatch ? valueMatch[1] : inner).replace(/<[^>]+>/g, "").trim();
  return text === "" ? null : text;
}

function tagNumber(xml, tag) {
  const text = tagText(xml, tag);
  if (text == null) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function tagFlag(xml, tag) {
  const text = tagText(xml, tag);
  return text === "1" || text === "true";
}

// ticker -> CIK. Un unico fetch para todo el mercado.
async function loadTickerCikMap() {
  const data = await secFetch(TICKERS_URL, { json: true });
  const map = new Map();
  if (!data) return map;
  for (const entry of Object.values(data)) {
    if (!entry?.ticker) continue;
    map.set(String(entry.ticker).toUpperCase(), padCik(entry.cik_str));
  }
  return map;
}

// Formularios 4 en los que la empresa es el EMISOR (no el insider).
// El bloque `recent` cubre las ultimas ~1000 presentaciones, que para una
// empresa del S&P 500 son varios anos: no hace falta backfill.
async function fetchRecentForm4Filings(cik, sinceDate) {
  const data = await secFetch(`${SUBMISSIONS}${padCik(cik)}.json`, { json: true });
  const recent = data?.filings?.recent;
  if (!recent?.form) return [];

  const out = [];
  for (let i = 0; i < recent.form.length; i += 1) {
    if (recent.form[i] !== "4") continue;
    const filingDate = recent.filingDate[i];
    if (sinceDate && filingDate < sinceDate) continue;
    out.push({
      accession: recent.accessionNumber[i],
      filingDate,
      reportDate: recent.reportDate?.[i] || null,
      primaryDocument: recent.primaryDocument[i],
    });
  }
  return out;
}

// El primaryDocument apunta a la version renderizada con XSL
// (xslF345X06/form4.xml). El XML crudo es la misma ruta sin ese prefijo.
function rawDocumentUrl(cik, accession, primaryDocument) {
  const accNoDashes = String(accession).replace(/-/g, "");
  const raw = String(primaryDocument).replace(/^xsl[^/]*\//, "");
  return `${ARCHIVES}/${Number(padCik(cik))}/${accNoDashes}/${raw}`;
}

function parseForm4(xml) {
  if (!xml || !xml.includes("<ownershipDocument")) return null;

  const owners = [...xml.matchAll(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/g)].map((m) => {
    const block = m[1];
    return {
      cik: tagText(block, "rptOwnerCik"),
      name: tagText(block, "rptOwnerName"),
      is_director: tagFlag(block, "isDirector"),
      is_officer: tagFlag(block, "isOfficer"),
      is_ten_percent_owner: tagFlag(block, "isTenPercentOwner"),
      title: tagText(block, "officerTitle"),
    };
  });

  const transactions = [...xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)].map((m) => {
    const block = m[1];
    return {
      date: tagText(block, "transactionDate"),
      code: tagText(block, "transactionCode"),
      shares: tagNumber(block, "transactionShares"),
      price: tagNumber(block, "transactionPricePerShare"),
      acquired_disposed: tagText(block, "transactionAcquiredDisposedCode"),
    };
  });

  return {
    issuer_cik: tagText(xml, "issuerCik"),
    issuer_name: tagText(xml, "issuerName"),
    symbol: tagText(xml, "issuerTradingSymbol"),
    period_of_report: tagText(xml, "periodOfReport"),
    has_10b5_1_plan: /10b5-?1/i.test(xml),
    owners,
    transactions,
  };
}

async function fetchForm4(cik, filing) {
  const xml = await secFetch(rawDocumentUrl(cik, filing.accession, filing.primaryDocument));
  const parsed = parseForm4(xml);
  if (!parsed) return null;
  return { ...parsed, accession: filing.accession, filing_date: filing.filingDate };
}

// Reduce un formulario 4 a las compras de mercado abierto hechas por
// directivos o consejeros. Devuelve [] si no aplica.
function extractInsiderBuys(form4, { includeTenPercentOwners = false } = {}) {
  if (!form4) return [];
  if (form4.has_10b5_1_plan) return [];

  const insiders = form4.owners.filter(
    (o) => o.is_officer || o.is_director || (includeTenPercentOwners && o.is_ten_percent_owner),
  );
  if (!insiders.length) return [];

  const buys = form4.transactions.filter(
    (t) => t.code === OPEN_MARKET_BUY && t.acquired_disposed === "A" && Number.isFinite(t.shares) && t.shares > 0,
  );
  if (!buys.length) return [];

  const shares = buys.reduce((sum, t) => sum + t.shares, 0);
  const value = buys.reduce((sum, t) => sum + t.shares * (Number.isFinite(t.price) ? t.price : 0), 0);
  const dates = buys.map((t) => t.date).filter(Boolean).sort();

  return insiders.map((owner) => ({
    symbol: form4.symbol,
    issuer_cik: form4.issuer_cik,
    issuer_name: form4.issuer_name,
    accession: form4.accession,
    filing_date: form4.filing_date,
    transaction_date: dates[0] || form4.period_of_report,
    owner_cik: owner.cik,
    owner_name: owner.name,
    owner_title: owner.title || (owner.is_director ? "Director" : "Officer"),
    is_officer: owner.is_officer,
    is_director: owner.is_director,
    has_10b5_1_plan: Boolean(form4.has_10b5_1_plan),
    shares,
    value_usd: value,
  }));
}

module.exports = {
  SEC_USER_AGENT,
  OPEN_MARKET_BUY,
  secFetch,
  padCik,
  tagText,
  tagNumber,
  tagFlag,
  loadTickerCikMap,
  fetchRecentForm4Filings,
  rawDocumentUrl,
  parseForm4,
  fetchForm4,
  extractInsiderBuys,
};
