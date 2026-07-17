const FALLBACK_UNIVERSE = require("../data/sp500_fallback.json");

const WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";

const BENCHMARKS = ["SPY", "QQQ"];
const WINDOWS = { ret_1w: 5, ret_1m: 21, ret_2m: 42, ret_3m: 63, ret_6m: 126, ret_1y: 252 };

const MIN_PRICE = 5;
const MIN_DOLLAR_VOLUME_20D = 5_000_000;
const MIN_EXECUTION_RR = 1.2;
const MIN_DEEP_PULLBACK_RR = 2.0;

const CORE_MIN_SCORE = 0.70;
const CORE_MIN_EXPLOSIVE = 0.75;
const CORE_MAX_DIST_SMA50 = 0.20;
const CORE_MIN_VOLUME = 0.85;
const CORE_MIN_52W_DISTANCE = -0.10;
const CORE_MAX_RANK = 75;
const CORE_MIN_RET_1W = -0.025;
const CORE_MAX_VOLATILITY_20D = 0.35;
const MAX_MACD_HIST_SLOPE_DECAY = -0.10;
const RSI_BUY_MIN = 46;
const RSI_BUY_MAX = 65;

const MOMENTUM_MIN_SCORE = 0.70;
const MOMENTUM_MIN_EXPLOSIVE = 0.75;
const MOMENTUM_MIN_VOLUME = 1.00;
const MOMENTUM_MAX_DIST_SMA50 = 0.10;
const MOMENTUM_MIN_RET_1W = -0.03;
const MOMENTUM_MAX_RET_1W = 0.08;
const MOMENTUM_MAX_RANK = 50;
const MOMENTUM_MAX_POSITION_PCT = 0.05;
const MOMENTUM_RSI_BUY_MIN = 50;
const MOMENTUM_RSI_BUY_MAX = 72;
const MOMENTUM_MAX_MACD_HIST_SLOPE_DECAY = -0.05;

const MAX_NEW_BUYS_PER_DAY = 3;
const MAX_BUYS_PER_SECTOR_PER_DAY = 2;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clip(value, lo, hi) {
  const n = finite(value, 0);
  return Math.max(lo, Math.min(hi, n));
}

function mean(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function std(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return null;
  const m = mean(clean);
  const variance = clean.reduce((a, b) => a + (b - m) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(variance);
}

function sma(values, n) {
  if (values.length < n) return null;
  return mean(values.slice(-n));
}

function pctReturn(values, n) {
  if (values.length <= n) return null;
  const latest = values[values.length - 1];
  const ref = values[values.length - 1 - n];
  if (!Number.isFinite(latest) || !Number.isFinite(ref) || ref === 0) return null;
  return latest / ref - 1;
}

function maxLast(values, n) {
  const slice = values.slice(Math.max(0, values.length - n)).filter((v) => Number.isFinite(v));
  return slice.length ? Math.max(...slice) : null;
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      out.push(prev);
      continue;
    }
    prev = prev == null ? value : value * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi14(values) {
  if (values.length < 20) return null;
  const gains = [];
  const losses = [];
  for (let i = 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    gains.push(Math.max(delta, 0));
    losses.push(Math.max(-delta, 0));
  }

  const alpha = 1 / 14;
  let avgGain = null;
  let avgLoss = null;
  for (let i = 0; i < gains.length; i += 1) {
    if (i < 13) continue;
    if (i === 13) {
      avgGain = mean(gains.slice(0, 14));
      avgLoss = mean(losses.slice(0, 14));
    } else {
      avgGain = alpha * gains[i] + (1 - alpha) * avgGain;
      avgLoss = alpha * losses[i] + (1 - alpha) * avgLoss;
    }
  }
  if (avgGain == null || avgLoss == null) return null;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(values) {
  if (values.length < 35) return { macd: null, signal: null, hist: null, histSlope: null };
  const ema12 = emaSeries(values, 12);
  const ema26 = emaSeries(values, 26);
  const macdLine = values.map((_, i) => {
    if (ema12[i] == null || ema26[i] == null) return null;
    return ema12[i] - ema26[i];
  });
  const signal = emaSeries(macdLine, 9);
  const last = macdLine[macdLine.length - 1];
  const sig = signal[signal.length - 1];
  const hist = last == null || sig == null ? null : last - sig;
  const prevLast = macdLine[macdLine.length - 2];
  const prevSig = signal[signal.length - 2];
  const prevHist = prevLast == null || prevSig == null ? null : prevLast - prevSig;
  return {
    macd: last,
    signal: sig,
    hist,
    histSlope: hist == null || prevHist == null ? null : hist - prevHist,
  };
}

function dailyReturns(values) {
  const out = [];
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1];
    const current = values[i];
    if (Number.isFinite(prev) && prev !== 0 && Number.isFinite(current)) out.push(current / prev - 1);
  }
  return out;
}

function pctRanks(rows, key) {
  const clean = rows
    .map((row) => finite(row[key]))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const n = clean.length;
  const ranks = new Map();
  clean.forEach((value, idx) => ranks.set(value, (idx + 1) / n));
  return rows.map((row) => (Number.isFinite(row[key]) ? ranks.get(row[key]) || 0 : 0));
}

function yahooSymbol(symbol) {
  return String(symbol || "").trim().replace(/\./g, "-");
}

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

async function fetchText(url, timeoutMs = 15000) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response.text();
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

async function fetchChart(symbol, timeoutMs = 15000) {
  const url = `${YAHOO_CHART}${encodeURIComponent(symbol)}?range=1y&interval=1d&events=history&includeAdjustedClose=true`;
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
    const close = finite(adjusted[i], finite(quote.close?.[i]));
    const volume = finite(quote.volume?.[i], 0);
    if (!Number.isFinite(close)) continue;
    rows.push({
      date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
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
      if (Number.isFinite(result.meta?.regularMarketVolume)) last.volume = result.meta.regularMarketVolume;
    } else if (last.date < regularDate) {
      rows.push({
        date: regularDate,
        close: regularPrice,
        volume: finite(result.meta?.regularMarketVolume, 0),
      });
    }
  }

  if (rows.length < 220) throw new Error(`historial insuficiente: ${rows.length}`);
  return { symbol, rows, meta: result.meta || {} };
}

async function fetchCharts(symbols, concurrency = 24) {
  let cursor = 0;
  const ok = [];
  const failed = [];

  async function worker() {
    while (cursor < symbols.length) {
      const symbol = symbols[cursor];
      cursor += 1;
      try {
        ok.push(await fetchChart(symbol));
      } catch (error) {
        failed.push({ symbol, error: error.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
  return { ok, failed };
}

function computeRawFeature(chart, metaByTicker = new Map()) {
  const closes = chart.rows.map((row) => row.close).filter((value) => Number.isFinite(value));
  const volumes = chart.rows.map((row) => row.volume || 0);
  const latestClose = closes[closes.length - 1];
  const latestDate = chart.rows[chart.rows.length - 1]?.date;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const high63 = maxLast(closes, 63);
  const high252 = maxLast(closes, 252);
  const avgVol20 = sma(volumes, 20);
  const avgVol60 = sma(volumes, 60);
  const dollarVolume20d = mean(closes.slice(-20).map((close, i) => close * (volumes.slice(-20)[i] || 0)));
  const returns = dailyReturns(closes);
  const vol20 = std(returns.slice(-20));
  const macdValues = macd(closes);
  const tickerMeta = metaByTicker.get(chart.symbol) || {};

  return {
    ticker: chart.symbol,
    name: tickerMeta.name || chart.meta?.longName || chart.symbol,
    gics_sector: tickerMeta.gics_sector || "",
    gics_sub_industry: tickerMeta.gics_sub_industry || "",
    run_date: latestDate,
    price: latestClose,
    ret_1w: pctReturn(closes, WINDOWS.ret_1w),
    ret_1m: pctReturn(closes, WINDOWS.ret_1m),
    ret_2m: pctReturn(closes, WINDOWS.ret_2m),
    ret_3m: pctReturn(closes, WINDOWS.ret_3m),
    ret_6m: pctReturn(closes, WINDOWS.ret_6m),
    ret_1y: pctReturn(closes, WINDOWS.ret_1y),
    sma20,
    sma50,
    sma200,
    dist_sma20: sma20 ? latestClose / sma20 - 1 : null,
    dist_sma50: sma50 ? latestClose / sma50 - 1 : null,
    dist_sma200: sma200 ? latestClose / sma200 - 1 : null,
    pct_from_63d_high: high63 ? latestClose / high63 - 1 : null,
    pct_from_52w_high: high252 ? latestClose / high252 - 1 : null,
    volume_ratio_20_60: avgVol20 && avgVol60 ? avgVol20 / avgVol60 : null,
    dollar_volume_20d: dollarVolume20d,
    volatility_20d: vol20 == null ? null : vol20 * Math.sqrt(252),
    rsi14: rsi14(closes),
    macd: macdValues.macd,
    macd_signal: macdValues.signal,
    macd_hist: macdValues.hist,
    macd_hist_slope: macdValues.histSlope,
    above_sma20: sma20 ? latestClose > sma20 : false,
    above_sma50: sma50 ? latestClose > sma50 : false,
  };
}

function addScoresAndSetups(rows) {
  const spy = rows.find((row) => row.ticker === "SPY");
  const qqq = rows.find((row) => row.ticker === "QQQ");
  for (const row of rows) {
    row.rs_1m_vs_spy = spy?.ret_1m == null ? null : row.ret_1m - spy.ret_1m;
    row.rs_3m_vs_spy = spy?.ret_3m == null ? null : row.ret_3m - spy.ret_3m;
    row.rs_3m_vs_qqq = qqq?.ret_3m == null ? null : row.ret_3m - qqq.ret_3m;
  }

  const tradable = rows.filter((row) => {
    if (BENCHMARKS.includes(row.ticker)) return false;
    return row.price >= MIN_PRICE && row.dollar_volume_20d >= MIN_DOLLAR_VOLUME_20D;
  });

  const ranks = {};
  [
    "ret_1m",
    "ret_3m",
    "ret_6m",
    "ret_1y",
    "rs_1m_vs_spy",
    "rs_3m_vs_spy",
    "volume_ratio_20_60",
    "pct_from_52w_high",
    "pct_from_63d_high",
    "dist_sma50",
    "dist_sma200",
  ].forEach((key) => {
    ranks[key] = pctRanks(tradable, key);
  });

  for (let i = 0; i < tradable.length; i += 1) {
    const row = tradable[i];
    row.momentum_score =
      0.15 * ranks.ret_1m[i] +
      0.25 * ranks.ret_3m[i] +
      0.20 * ranks.ret_6m[i] +
      0.10 * ranks.ret_1y[i] +
      0.15 * ranks.rs_3m_vs_spy[i] +
      0.10 * ranks.volume_ratio_20_60[i] +
      0.05 * ranks.dist_sma200[i];
    row.explosive_score =
      0.25 * ranks.ret_1m[i] +
      0.25 * ranks.ret_3m[i] +
      0.15 * ranks.rs_1m_vs_spy[i] +
      0.15 * ranks.rs_3m_vs_spy[i] +
      0.10 * ranks.volume_ratio_20_60[i] +
      0.10 * ranks.pct_from_52w_high[i];
    row.breakout_score =
      0.35 * ranks.pct_from_52w_high[i] +
      0.20 * ranks.pct_from_63d_high[i] +
      0.20 * ranks.volume_ratio_20_60[i] +
      0.15 * ranks.ret_1m[i] +
      0.10 * ranks.dist_sma50[i];

    const extendedSma50 = clip((row.dist_sma50 - 0.18) / 0.25, 0, 1);
    const farFromHigh = clip((-row.pct_from_52w_high - 0.15) / 0.35, 0, 1);
    const brokenSma50 = row.dist_sma50 < 0 ? 1 : 0;
    const sharpDrop = clip((-row.ret_1w - 0.05) / 0.20, 0, 1);
    const volRisk = clip((0.80 - row.volume_ratio_20_60) / 0.80, 0, 1);
    row.risk_score = 0.30 * extendedSma50 + 0.25 * farFromHigh + 0.20 * brokenSma50 + 0.15 * sharpDrop + 0.10 * volRisk;
    row.score = clip(0.45 * row.momentum_score + 0.35 * row.explosive_score + 0.20 * row.breakout_score - 0.15 * row.risk_score, 0, 1);

    const extended = row.dist_sma50 > 0.25 || (row.ret_1m > 0.35 && row.dist_sma50 > 0.18);
    const weakening = row.dist_sma50 < 0 || (row.ret_1w < -0.08 && row.ret_1m < 0.02);
    const hot = row.explosive_score >= 0.80 && row.ret_1m > 0.08 && row.ret_3m > 0.20 && row.pct_from_52w_high > -0.12 && row.dist_sma50 > 0;
    const pullback = row.ret_3m > 0.15 && row.ret_6m > 0.20 && row.ret_1w < 0 && row.ret_1w > -0.15 && row.dist_sma200 > 0 && row.pct_from_52w_high > -0.25;
    const nearBreakout = row.pct_from_52w_high > -0.05 && row.ret_1m > 0.03 && row.volume_ratio_20_60 > 0.95 && row.dist_sma50 > 0;
    const early = row.ret_1m > 0.08 && row.ret_3m > 0.08 && row.volume_ratio_20_60 > 1.05 && row.dist_sma50 > -0.03 && row.dist_sma50 < 0.20;

    row.setup_type = extended ? "EXTENDED" : weakening ? "WEAKENING" : hot ? "HOT_MOMENTUM" : pullback ? "PULLBACK_IN_TREND" : nearBreakout ? "NEAR_BREAKOUT" : early ? "EARLY_MOMENTUM" : "NORMAL";
    row.risk_flags = riskFlags(row).join(", ");
  }

  tradable.sort((a, b) => b.score - a.score);
  tradable.forEach((row, idx) => {
    row.rank_today = idx + 1;
  });
  return tradable;
}

function riskFlags(row) {
  const flags = [];
  if (row.dist_sma50 > 0.20) flags.push("EXTENDED_FROM_SMA50");
  if (row.pct_from_52w_high < -0.25) flags.push("FAR_FROM_52W_HIGH");
  if (row.dist_sma50 < 0) flags.push("BROKEN_SMA50");
  if (row.ret_1w < -0.08) flags.push("SHARP_1W_DROP");
  if (row.volume_ratio_20_60 < 0.75) flags.push("LOW_VOLUME_CONFIRMATION");
  return flags;
}

function optimizedScore(row) {
  const nearHigh = clip(1 + row.pct_from_52w_high, 0, 1);
  const volume = clip((row.volume_ratio_20_60 - 0.75) / 0.50, 0, 1);
  const sma50Quality = clip(1 - Math.abs(row.dist_sma50 - 0.08) / 0.15, 0, 1);
  const pullbackQuality = clip(1 - Math.abs(row.ret_1w + 0.02) / 0.08, 0, 1);
  const raw = 0.35 * row.score + 0.25 * row.explosive_score + 0.15 * volume + 0.10 * nearHigh + 0.10 * sma50Quality + 0.05 * pullbackQuality - 0.20 * row.risk_score;
  return Math.round(1000 * clip(raw, 0, 1)) / 10;
}

function momentumOptScore(row) {
  const nearHigh = clip(1 + row.pct_from_52w_high, 0, 1);
  const volume = clip((row.volume_ratio_20_60 - 0.90) / 0.70, 0, 1);
  const sma50Compact = clip(1 - Math.abs(row.dist_sma50) / MOMENTUM_MAX_DIST_SMA50, 0, 1);
  const ret1wQuality = clip(1 - Math.abs(row.ret_1w - 0.025) / 0.08, 0, 1);
  const raw = 0.30 * row.score + 0.25 * row.breakout_score + 0.20 * row.explosive_score + 0.10 * volume + 0.10 * sma50Compact + 0.05 * ret1wQuality + 0.05 * nearHigh - 0.15 * row.risk_score;
  return Math.round(1000 * clip(raw, 0, 1)) / 10;
}

function ruleCore(row) {
  return (
    row.setup_type === "PULLBACK_IN_TREND" &&
    row.score >= CORE_MIN_SCORE &&
    row.explosive_score >= CORE_MIN_EXPLOSIVE &&
    row.dist_sma50 >= 0 &&
    row.dist_sma50 <= CORE_MAX_DIST_SMA50 &&
    row.volume_ratio_20_60 >= CORE_MIN_VOLUME &&
    row.ret_1w >= CORE_MIN_RET_1W &&
    row.volatility_20d <= CORE_MAX_VOLATILITY_20D &&
    !row.risk_flags &&
    row.pct_from_52w_high > CORE_MIN_52W_DISTANCE &&
    row.rank_today <= CORE_MAX_RANK
  );
}

function ruleBreakout(row) {
  return (
    row.setup_type === "NEAR_BREAKOUT" &&
    row.rank_today <= MOMENTUM_MAX_RANK &&
    row.score >= MOMENTUM_MIN_SCORE &&
    row.explosive_score >= MOMENTUM_MIN_EXPLOSIVE &&
    row.volume_ratio_20_60 >= MOMENTUM_MIN_VOLUME &&
    row.dist_sma50 >= 0 &&
    row.dist_sma50 <= MOMENTUM_MAX_DIST_SMA50 &&
    row.ret_1w >= MOMENTUM_MIN_RET_1W &&
    row.ret_1w <= MOMENTUM_MAX_RET_1W &&
    !/BROKEN_SMA50|SHARP_1W_DROP|FAR_FROM_52W_HIGH/.test(row.risk_flags || "")
  );
}

function addTradePlan(row) {
  const dailyVol = clip((row.volatility_20d || 0.25) / Math.sqrt(252), 0.008, 0.05);
  const isMomentum = row.strategy_family === "BREAKOUT_CONTINUATION";
  const stopLossPct = isMomentum ? clip(1.4 * dailyVol, 0.035, 0.065) : clip(1.8 * dailyVol, 0.04, 0.10);
  const takeProfitPct = isMomentum ? clip(1.65 * stopLossPct, 0.055, 0.105) : clip(1.8 * stopLossPct, 0.07, 0.18);
  const entryZoneLow = row.price * (isMomentum ? 0.990 : 0.995);
  const entryZoneHigh = row.price * (isMomentum ? 1.003 : 1.005);
  let maxPositionPct = row.volatility_20d <= 0.30 ? 0.10 : 0.07;
  if (row.volatility_20d >= 0.45) maxPositionPct = 0.05;
  if (isMomentum) maxPositionPct = Math.min(maxPositionPct, MOMENTUM_MAX_POSITION_PCT);

  return {
    ...row,
    stop_loss_pct: stopLossPct,
    take_profit_pct: takeProfitPct,
    entry_zone_low: entryZoneLow,
    entry_zone_high: entryZoneHigh,
    invalid_below_price: row.price * (1 - stopLossPct),
    target_price: row.price * (1 + takeProfitPct),
    max_position_pct: maxPositionPct,
  };
}

function executionFilter(rows) {
  const evaluated = rows.map((row) => {
    const isMomentum = row.strategy_family === "BREAKOUT_CONTINUATION";
    const rsiMin = isMomentum ? MOMENTUM_RSI_BUY_MIN : RSI_BUY_MIN;
    const rsiMax = isMomentum ? MOMENTUM_RSI_BUY_MAX : RSI_BUY_MAX;
    const slopeFloor = isMomentum ? MOMENTUM_MAX_MACD_HIST_SLOPE_DECAY : MAX_MACD_HIST_SLOPE_DECAY;
    const lastClose = row.price;
    const reward = row.target_price / lastClose - 1;
    const risk = (lastClose - row.invalid_below_price) / lastClose;
    const rr = risk > 0 ? reward / risk : null;
    const priceZoneOk = lastClose <= row.entry_zone_high && lastClose >= row.entry_zone_low * 0.99;
    const rsiOk = row.rsi14 >= rsiMin && row.rsi14 <= rsiMax;
    const trendOk = row.above_sma20 && row.above_sma50;
    const macdCrossOk = row.macd >= row.macd_signal;
    const macdRecoveryOk = row.macd_hist_slope > 0.05 && row.macd_hist > -0.25;
    const macdDecayOk = row.macd_hist_slope >= slopeFloor;
    const coreMacdOk = (macdCrossOk && macdDecayOk && row.macd_hist > 0) || macdRecoveryOk;
    const momentumMacdOk = macdDecayOk && ((macdCrossOk && row.macd_hist > -0.10) || (row.macd_hist > 0 && row.macd_hist_slope > -0.02));
    const macdOk = isMomentum ? momentumMacdOk : coreMacdOk;
    const rrOk = rr >= MIN_EXECUTION_RR;
    const hardInvalid = lastClose <= row.invalid_below_price || !row.above_sma50 || row.rsi14 < 40;
    const setupAlive = !hardInvalid && lastClose < row.target_price;
    const deepPullbackEntry =
      row.strategy_family === "CORE_PULLBACK" &&
      setupAlive &&
      lastClose < row.entry_zone_low &&
      lastClose > row.invalid_below_price * 1.01 &&
      row.above_sma50 &&
      row.rsi14 >= 45 &&
      row.rsi14 <= 60 &&
      row.macd_hist_slope > -0.05 &&
      rr >= MIN_DEEP_PULLBACK_RR;
    const executionValid = priceZoneOk && rsiOk && trendOk && macdOk && rrOk && !hardInvalid;
    const entryAllowed = executionValid || deepPullbackEntry;

    return {
      ...row,
      last_close: lastClose,
      reward_from_execution: reward,
      risk_to_stop_from_execution: risk,
      risk_reward_ratio: rr,
      rsi_min_rule: rsiMin,
      rsi_max_rule: rsiMax,
      price_zone_ok: priceZoneOk,
      rsi_ok: rsiOk,
      trend_ok: trendOk,
      macd_ok: macdOk,
      rr_ok: rrOk,
      hard_invalid: hardInvalid,
      setup_alive: setupAlive,
      deep_pullback_entry: deepPullbackEntry,
      execution_valid: executionValid,
      entry_allowed: entryAllowed,
    };
  });

  const eligible = evaluated
    .filter((row) => row.entry_allowed)
    .sort((a, b) => (b.risk_reward_ratio - a.risk_reward_ratio) || (b.opt_score - a.opt_score) || (a.rank_today - b.rank_today));
  const sectorCounts = new Map();
  eligible.forEach((row, idx) => {
    row.portfolio_buy_rank = idx + 1;
    const sector = row.gics_sector || "SIN_SECTOR";
    const count = (sectorCounts.get(sector) || 0) + 1;
    sectorCounts.set(sector, count);
    row.sector_signal_rank = count;
    row.portfolio_allowed = row.portfolio_buy_rank <= MAX_NEW_BUYS_PER_DAY && row.sector_signal_rank <= MAX_BUYS_PER_SECTOR_PER_DAY;
  });

  for (const row of evaluated) {
    if (!row.entry_allowed) {
      row.portfolio_buy_rank = null;
      row.sector_signal_rank = null;
      row.portfolio_allowed = false;
      row.portfolio_limit_reason = "No es entrada";
    } else if (row.portfolio_allowed) {
      row.portfolio_limit_reason = "Autorizada por cartera";
    } else if (row.portfolio_buy_rank > MAX_NEW_BUYS_PER_DAY) {
      row.portfolio_limit_reason = `Bloqueada: max ${MAX_NEW_BUYS_PER_DAY} compras nuevas al dia`;
    } else if (row.sector_signal_rank > MAX_BUYS_PER_SECTOR_PER_DAY) {
      row.portfolio_limit_reason = `Bloqueada: max ${MAX_BUYS_PER_SECTOR_PER_DAY} compras por sector`;
    } else {
      row.portfolio_limit_reason = "Valida tecnicamente, revisar cartera";
    }

    row.Accion_Ejecucion = executionAction(row);
    row.Motivo_Ejecucion = executionReason(row);
    row.tamano_entrada_pct = row.portfolio_allowed ? (row.deep_pullback_entry ? row.max_position_pct * 0.5 : row.max_position_pct) : 0;
    row.Plan_Orden = row.portfolio_allowed
      ? row.strategy_family === "BREAKOUT_CONTINUATION"
        ? "Entrada momentum limitada; tamano max 5%; no perseguir gap"
        : "Entrada normal con limitada dentro de zona; no perseguir gap"
      : row.entry_allowed
        ? "No abrir por limite de cartera/sector; mantener en radar"
        : "Esperar nueva entrada; no comprar a mercado";
  }

  return evaluated.sort(
    (a, b) =>
      Number(b.portfolio_allowed) - Number(a.portfolio_allowed) ||
      Number(b.entry_allowed) - Number(a.entry_allowed) ||
      (b.risk_reward_ratio || 0) - (a.risk_reward_ratio || 0) ||
      (b.opt_score || 0) - (a.opt_score || 0),
  );
}

function executionAction(row) {
  if (row.hard_invalid) return "INVALIDADA_NO_COMPRAR";
  if (row.entry_allowed && !row.portfolio_allowed) return "ESPERAR_LIMITE_CARTERA";
  if (row.portfolio_allowed && row.deep_pullback_entry) return "COMPRAR_1_2_PULLBACK";
  if (row.portfolio_allowed) return "COMPRAR_LIMITADA";
  if (!row.macd_ok) return "ESPERAR_CONFIRMACION";
  if (!row.rsi_ok) return "ESPERAR_RSI";
  if (!row.rr_ok) return "ESPERAR_MEJOR_RR";
  if (!row.price_zone_ok) return "ESPERAR_PRECIO";
  return "REVISAR_MANUAL";
}

function executionReason(row) {
  if (row.hard_invalid) return "Setup invalidado: ha roto stop/SMA50 o el deterioro es excesivo";
  if (row.entry_allowed && !row.portfolio_allowed) return "Entrada tecnicamente valida, pero excede limite diario o limite por sector";
  const reasons = [];
  if (!row.price_zone_ok) reasons.push("precio fuera de zona");
  if (!row.rsi_ok) reasons.push(row.strategy_family === "BREAKOUT_CONTINUATION" ? "RSI fuera de rango momentum" : "RSI no ideal");
  if (!row.trend_ok) reasons.push("precio bajo SMA20/SMA50");
  if (!row.macd_ok) reasons.push(row.macd >= row.macd_signal ? "MACD confirmado pero perdiendo fuerza" : "MACD sin confirmacion");
  if (!row.rr_ok) reasons.push("beneficio/riesgo insuficiente");
  return reasons.length ? reasons.join("; ") : "Entrada valida si abre dentro de zona y no persigue gap";
}

function selectCandidates(ranked) {
  const core = ranked
    .filter(ruleCore)
    .map((row) => addTradePlan({ ...row, strategy_family: "CORE_PULLBACK", Accion: "BUY_CORE_PULLBACK", opt_score: optimizedScore(row) }));
  const coreTickers = new Set(core.map((row) => row.ticker));
  const breakout = ranked
    .filter((row) => !coreTickers.has(row.ticker) && ruleBreakout(row))
    .map((row) => addTradePlan({ ...row, strategy_family: "BREAKOUT_CONTINUATION", Accion: "BUY_BREAKOUT_CONTINUATION", opt_score: momentumOptScore(row) }));

  return core
    .concat(breakout)
    .sort((a, b) => {
      const pa = a.strategy_family === "CORE_PULLBACK" ? 0 : 1;
      const pb = b.strategy_family === "CORE_PULLBACK" ? 0 : 1;
      return pa - pb || b.opt_score - a.opt_score || a.rank_today - b.rank_today;
    });
}

function compactRow(row) {
  const keys = [
    "Accion_Ejecucion",
    "Accion",
    "ticker",
    "name",
    "gics_sector",
    "strategy_family",
    "rank_today",
    "last_close",
    "entry_zone_low",
    "entry_zone_high",
    "invalid_below_price",
    "target_price",
    "risk_reward_ratio",
    "rsi14",
    "macd",
    "macd_signal",
    "macd_hist",
    "macd_hist_slope",
    "portfolio_allowed",
    "portfolio_limit_reason",
    "tamano_entrada_pct",
    "Plan_Orden",
    "Motivo_Ejecucion",
  ];
  const out = {};
  for (const key of keys) {
    if (row[key] == null) out[key] = null;
    else if (typeof row[key] === "number") out[key] = Number(row[key].toFixed(6));
    else out[key] = row[key];
  }
  return out;
}

async function runScanner(options = {}) {
  const startedAt = Date.now();
  const concurrency = Number(options.concurrency || process.env.SCANNER_CONCURRENCY || 24);
  const maxSymbols = options.maxSymbols || Number(process.env.MAX_SYMBOLS || 0);
  const { universe, source } = await loadUniverse();
  const symbols = universe.map((row) => row.ticker);
  const allSymbols = [...new Set([...symbols, ...BENCHMARKS])];
  const selectedSymbols = maxSymbols > 0 ? allSymbols.slice(0, maxSymbols) : allSymbols;
  const metaByTicker = new Map(universe.map((row) => [row.ticker, row]));
  const { ok, failed } = await fetchCharts(selectedSymbols, concurrency);
  const raw = ok.map((chart) => computeRawFeature(chart, metaByTicker));
  const ranked = addScoresAndSetups(raw);
  const candidates = selectCandidates(ranked);
  const execution = executionFilter(candidates);
  const recommendations = execution.filter((row) => row.portfolio_allowed).map(compactRow);
  const technicalEntries = execution.filter((row) => row.entry_allowed).map(compactRow);
  const watch = execution.filter((row) => !row.portfolio_allowed).slice(0, 20).map(compactRow);

  return {
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
    universe_source: source,
    universe_count: universe.length,
    downloaded_count: ok.length,
    failed_count: failed.length,
    failed: failed.slice(0, 20),
    latest_market_date: raw.map((row) => row.run_date).sort().at(-1) || null,
    dashboard: {
      candidates_total: candidates.length,
      core_count: candidates.filter((row) => row.strategy_family === "CORE_PULLBACK").length,
      breakout_count: candidates.filter((row) => row.strategy_family === "BREAKOUT_CONTINUATION").length,
      technical_entry_count: technicalEntries.length,
      portfolio_entry_count: recommendations.length,
      hot_momentum_count: ranked.filter((row) => row.setup_type === "HOT_MOMENTUM").length,
      pullback_count: ranked.filter((row) => row.setup_type === "PULLBACK_IN_TREND").length,
      near_breakout_count: ranked.filter((row) => row.setup_type === "NEAR_BREAKOUT").length,
    },
    recommendations,
    technical_entries: technicalEntries,
    watch,
    top_ranked: ranked.slice(0, 50).map((row) => ({
      ticker: row.ticker,
      name: row.name,
      sector: row.gics_sector,
      rank_today: row.rank_today,
      setup_type: row.setup_type,
      score: Number(row.score.toFixed(6)),
      price: Number(row.price.toFixed(4)),
      ret_1w: Number(row.ret_1w.toFixed(6)),
      ret_1m: Number(row.ret_1m.toFixed(6)),
      dist_sma50: Number(row.dist_sma50.toFixed(6)),
      pct_from_52w_high: Number(row.pct_from_52w_high.toFixed(6)),
      volume_ratio_20_60: Number(row.volume_ratio_20_60.toFixed(6)),
      risk_flags: row.risk_flags,
    })),
    rules: {
      max_new_buys_per_day: MAX_NEW_BUYS_PER_DAY,
      max_buys_per_sector_per_day: MAX_BUYS_PER_SECTOR_PER_DAY,
      note: "No compra a mercado: usar entry_zone_high como limite maximo.",
    },
  };
}

module.exports = { runScanner };
