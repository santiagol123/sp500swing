// Estrategia de momentum tecnico sobre el S&P 500.
//
// Las reglas son las de upstream (regimen de mercado, integracion con la
// cartera real, umbrales endurecidos). Lo unico que se ha movido fuera es la
// parte compartida -- matematica, descarga y universo -- para que la estrategia
// de insiders pueda reutilizarla sin duplicar codigo.

const PORTFOLIO_DATA = require("../data/portfolio.json");
const { buildPortfolioSnapshot, scannerContextFromPortfolio } = require("./portfolio");
const { finite, clip, mean, std, sma, pctReturn, maxLast, rsi14, macd, dailyReturns, pctRanks } = require("./indicators");
const { fetchCharts } = require("./yahoo");
const { loadUniverse, BENCHMARKS } = require("./universe");

const WINDOWS = { ret_1w: 5, ret_1m: 21, ret_2m: 42, ret_3m: 63, ret_6m: 126, ret_1y: 252 };

const MIN_PRICE = 5;
const MIN_DOLLAR_VOLUME_20D = 5_000_000;
const MIN_CORE_EXECUTION_RR = 1.45;
const MIN_MOMENTUM_EXECUTION_RR = 1.65;
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

const MOMENTUM_MIN_SCORE = 0.74;
const MOMENTUM_MIN_EXPLOSIVE = 0.78;
const MOMENTUM_MIN_VOLUME = 1.08;
const MOMENTUM_MAX_DIST_SMA50 = 0.08;
const MOMENTUM_MIN_RET_1W = -0.03;
const MOMENTUM_MAX_RET_1W = 0.08;
const MOMENTUM_MAX_RANK = 35;
const MOMENTUM_MAX_POSITION_PCT = 0.05;
const MOMENTUM_RSI_BUY_MIN = 50;
const MOMENTUM_RSI_BUY_MAX = 72;
const MOMENTUM_MAX_MACD_HIST_SLOPE_DECAY = -0.05;
const MOMENTUM_MIN_OPT_SCORE = 55;
const MOMENTUM_MIN_RS_1M_VS_SPY = 0.005;
const MOMENTUM_MIN_RS_3M_VS_SPY = 0;

const LEADER_MIN_SCORE = 0.76;
const LEADER_MIN_OPT_SCORE = 58;
const LEADER_MAX_RANK = 45;
const LEADER_MIN_RET_1W = -0.02;
const LEADER_MAX_RET_1W = 0.16;
const LEADER_MIN_RET_1M = 0.06;
const LEADER_MIN_RET_3M = 0.08;
const LEADER_MIN_VOLUME = 0.80;
const LEADER_MAX_DIST_SMA50 = 0.22;
const LEADER_MAX_VOLATILITY_20D = 0.50;
const LEADER_MIN_RS_1M_VS_SPY = 0;
const LEADER_MIN_RS_3M_VS_SPY = -0.01;
const LEADER_RSI_BUY_MIN = 50;
const LEADER_RSI_BUY_MAX = 78;
const LEADER_MAX_POSITION_PCT = 0.06;
const LEADER_MIN_EXECUTION_RR = 1.35;

const MAX_NEW_BUYS_PER_DAY = 2;
const MAX_BUYS_PER_SECTOR_PER_DAY = 1;
const MAX_OPEN_POSITIONS = 10;
const MAX_OPEN_POSITIONS_PER_SECTOR = 2;
const MAX_OPEN_MOMENTUM_POSITIONS = 8;

const MARKET_MIN_RET_1W = -0.015;
const MARKET_MIN_DIST_SMA20 = -0.012;
const MARKET_RISK_OFF_RET_1W = -0.035;
const MARKET_RISK_OFF_DIST_SMA20 = -0.03;

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

function compactMetric(value, digits = 6) {
  const n = finite(value, null);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}

function benchmarkSnapshot(row) {
  if (!row) return null;
  return {
    ticker: row.ticker,
    price: compactMetric(row.price, 4),
    ret_1w: compactMetric(row.ret_1w),
    ret_1m: compactMetric(row.ret_1m),
    dist_sma20: compactMetric(row.dist_sma20),
    dist_sma50: compactMetric(row.dist_sma50),
    above_sma20: Boolean(row.above_sma20),
    above_sma50: Boolean(row.above_sma50),
    macd_hist: compactMetric(row.macd_hist),
    macd_hist_slope: compactMetric(row.macd_hist_slope),
  };
}

function marketRegimeFromRows(rows) {
  const spy = rows.find((row) => row.ticker === "SPY");
  const qqq = rows.find((row) => row.ticker === "QQQ");

  if (!spy) {
    return {
      state: "unknown",
      allows_core: true,
      allows_momentum: false,
      reason: "SPY no disponible: se permite core defensivo y se bloquea momentum.",
      spy: null,
      qqq: benchmarkSnapshot(qqq),
    };
  }

  const spyRiskOff = !spy.above_sma50 || spy.ret_1w < MARKET_RISK_OFF_RET_1W || spy.dist_sma20 < MARKET_RISK_OFF_DIST_SMA20;
  const spyHealthy = spy.above_sma50 && spy.dist_sma20 >= MARKET_MIN_DIST_SMA20 && spy.ret_1w >= MARKET_MIN_RET_1W;
  const qqqHealthy = !qqq || (qqq.above_sma50 && qqq.ret_1w >= MARKET_MIN_RET_1W * 1.5);
  const state = spyRiskOff ? "risk_off" : spyHealthy && qqqHealthy ? "risk_on" : "neutral";

  return {
    state,
    allows_core: state !== "risk_off",
    allows_momentum: state === "risk_on",
    reason:
      state === "risk_on"
        ? "SPY/QQQ confirman tendencia: se permiten entradas core y momentum."
        : state === "neutral"
          ? "Mercado mixto: solo entradas core de alta calidad."
          : "Mercado debil: se bloquean nuevas compras.",
    spy: benchmarkSnapshot(spy),
    qqq: benchmarkSnapshot(qqq),
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

function leaderOptScore(row) {
  const nearHigh = clip(1 + row.pct_from_52w_high, 0, 1);
  const trend1m = clip(row.ret_1m / 0.20, 0, 1);
  const trend3m = clip(row.ret_3m / 0.35, 0, 1);
  const rs1m = clip((finite(row.rs_1m_vs_spy, 0) + 0.05) / 0.18, 0, 1);
  const rs3m = clip((finite(row.rs_3m_vs_spy, 0) + 0.05) / 0.22, 0, 1);
  const volume = clip((row.volume_ratio_20_60 - 0.70) / 0.70, 0, 1);
  const notExtended = clip(1 - Math.max(0, row.dist_sma50 - 0.08) / 0.18, 0, 1);
  const raw =
    0.25 * row.score +
    0.18 * row.explosive_score +
    0.16 * trend3m +
    0.12 * trend1m +
    0.10 * rs3m +
    0.08 * rs1m +
    0.06 * volume +
    0.03 * nearHigh +
    0.02 * notExtended -
    0.12 * row.risk_score;
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

function ruleLeader(row) {
  return (
    ["HOT_MOMENTUM", "NEAR_BREAKOUT", "EARLY_MOMENTUM", "NORMAL"].includes(row.setup_type) &&
    row.rank_today <= LEADER_MAX_RANK &&
    row.score >= LEADER_MIN_SCORE &&
    row.ret_1m >= LEADER_MIN_RET_1M &&
    row.ret_3m >= LEADER_MIN_RET_3M &&
    finite(row.rs_1m_vs_spy, -1) >= LEADER_MIN_RS_1M_VS_SPY &&
    finite(row.rs_3m_vs_spy, -1) >= LEADER_MIN_RS_3M_VS_SPY &&
    row.volume_ratio_20_60 >= LEADER_MIN_VOLUME &&
    row.dist_sma50 >= 0 &&
    row.dist_sma50 <= LEADER_MAX_DIST_SMA50 &&
    row.ret_1w >= LEADER_MIN_RET_1W &&
    row.ret_1w <= LEADER_MAX_RET_1W &&
    row.volatility_20d <= LEADER_MAX_VOLATILITY_20D &&
    row.pct_from_52w_high > -0.12 &&
    !/BROKEN_SMA50|SHARP_1W_DROP|FAR_FROM_52W_HIGH/.test(row.risk_flags || "")
  );
}

function addTradePlan(row) {
  const dailyVol = clip((row.volatility_20d || 0.25) / Math.sqrt(252), 0.008, 0.05);
  const isBreakout = row.strategy_family === "BREAKOUT_CONTINUATION";
  const isLeader = row.strategy_family === "LEADER_CONTINUATION";
  const isFastMomentum = isBreakout || isLeader;
  const stopLossPct = isFastMomentum ? clip(1.2 * dailyVol, 0.028, 0.045) : clip(1.5 * dailyVol, 0.032, 0.055);
  const takeProfitPct = isFastMomentum ? clip(1.9 * stopLossPct, 0.055, 0.09) : clip(1.9 * stopLossPct, 0.06, 0.11);
  const entryZoneLow = row.price * (isFastMomentum ? 0.990 : 0.994);
  const entryZoneHigh = row.price * (isFastMomentum ? 1.003 : 1.002);
  let maxPositionPct = row.volatility_20d <= 0.30 ? 0.10 : 0.07;
  if (row.volatility_20d >= 0.45) maxPositionPct = 0.05;
  if (isBreakout) maxPositionPct = Math.min(maxPositionPct, MOMENTUM_MAX_POSITION_PCT);
  if (isLeader) maxPositionPct = Math.min(maxPositionPct, LEADER_MAX_POSITION_PCT);

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

function executionFilter(rows, portfolioContext = {}) {
  const openTickers = portfolioContext.openTickers || new Set();
  const marketRegime = portfolioContext.marketRegime || { state: "unknown", allows_core: true, allows_momentum: false };
  const openPositionsCount = Number(portfolioContext.openPositionsCount || 0);
  const openSectorCounts = new Map(Object.entries(portfolioContext.openSectorCounts || {}));
  const openStrategyCounts = new Map(Object.entries(portfolioContext.openStrategyCounts || {}));

  const evaluated = rows.map((row) => {
    const isBreakout = row.strategy_family === "BREAKOUT_CONTINUATION";
    const isLeader = row.strategy_family === "LEADER_CONTINUATION";
    const isMomentum = isBreakout || isLeader;
    const rsiMin = isLeader ? LEADER_RSI_BUY_MIN : isBreakout ? MOMENTUM_RSI_BUY_MIN : RSI_BUY_MIN;
    const rsiMax = isLeader ? LEADER_RSI_BUY_MAX : isBreakout ? MOMENTUM_RSI_BUY_MAX : RSI_BUY_MAX;
    const rrMin = isLeader ? LEADER_MIN_EXECUTION_RR : isBreakout ? MIN_MOMENTUM_EXECUTION_RR : MIN_CORE_EXECUTION_RR;
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
    const rrOk = rr >= rrMin;
    const marketOk = isMomentum ? marketRegime.allows_momentum !== false : marketRegime.allows_core !== false;
    const rs1m = finite(row.rs_1m_vs_spy, null);
    const rs3m = finite(row.rs_3m_vs_spy, null);
    const relativeStrengthOk = isMomentum
      ? Number.isFinite(rs1m) &&
        rs1m >= (isLeader ? LEADER_MIN_RS_1M_VS_SPY : MOMENTUM_MIN_RS_1M_VS_SPY) &&
        Number.isFinite(rs3m) &&
        rs3m >= (isLeader ? LEADER_MIN_RS_3M_VS_SPY : MOMENTUM_MIN_RS_3M_VS_SPY)
      : !Number.isFinite(rs3m) || rs3m >= -0.025;
    const volumeConfirmationOk = row.volume_ratio_20_60 >= (isLeader ? LEADER_MIN_VOLUME : isBreakout ? MOMENTUM_MIN_VOLUME : CORE_MIN_VOLUME);
    const momentumQualityOk =
      !isMomentum ||
      (row.opt_score >= (isLeader ? LEADER_MIN_OPT_SCORE : MOMENTUM_MIN_OPT_SCORE) &&
        row.rank_today <= (isLeader ? LEADER_MAX_RANK : MOMENTUM_MAX_RANK));
    const sector = row.gics_sector || "SIN_SECTOR";
    const openSectorCount = Number(openSectorCounts.get(sector) || 0);
    const openMomentumCount =
      Number(openStrategyCounts.get("BREAKOUT_CONTINUATION") || 0) + Number(openStrategyCounts.get("LEADER_CONTINUATION") || 0);
    const portfolioCapacityOk =
      openPositionsCount < MAX_OPEN_POSITIONS &&
      openSectorCount < MAX_OPEN_POSITIONS_PER_SECTOR &&
      (!isMomentum || openMomentumCount < MAX_OPEN_MOMENTUM_POSITIONS);
    const hardInvalid = lastClose <= row.invalid_below_price || !row.above_sma50 || row.rsi14 < 40;
    const setupAlive = !hardInvalid && lastClose < row.target_price;
    const deepPullbackEntry =
      row.strategy_family === "CORE_PULLBACK" &&
      setupAlive &&
      marketOk &&
      relativeStrengthOk &&
      lastClose < row.entry_zone_low &&
      lastClose > row.invalid_below_price * 1.01 &&
      row.above_sma50 &&
      row.rsi14 >= 45 &&
      row.rsi14 <= 60 &&
      row.macd_hist_slope > -0.05 &&
      rr >= MIN_DEEP_PULLBACK_RR;
    const executionValid =
      priceZoneOk &&
      rsiOk &&
      trendOk &&
      macdOk &&
      rrOk &&
      marketOk &&
      relativeStrengthOk &&
      volumeConfirmationOk &&
      momentumQualityOk &&
      !hardInvalid;
    const alreadyHeld = openTickers.has(row.ticker);
    const entryAllowed = !alreadyHeld && (executionValid || deepPullbackEntry);

    return {
      ...row,
      already_held: alreadyHeld,
      last_close: lastClose,
      reward_from_execution: reward,
      risk_to_stop_from_execution: risk,
      risk_reward_ratio: rr,
      rsi_min_rule: rsiMin,
      rsi_max_rule: rsiMax,
      rr_min_rule: rrMin,
      market_state: marketRegime.state,
      market_ok: marketOk,
      relative_strength_ok: relativeStrengthOk,
      volume_confirmation_ok: volumeConfirmationOk,
      momentum_quality_ok: momentumQualityOk,
      portfolio_capacity_ok: portfolioCapacityOk,
      open_positions_count: openPositionsCount,
      open_sector_count: openSectorCount,
      open_momentum_count: openMomentumCount,
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
    .filter((row) => row.entry_allowed && row.portfolio_capacity_ok)
    .sort((a, b) => (b.risk_reward_ratio - a.risk_reward_ratio) || (b.opt_score - a.opt_score) || (a.rank_today - b.rank_today));
  const startingBuysToday = Number(portfolioContext.buysTodayCount || 0);
  const sectorCounts = new Map(Object.entries(portfolioContext.sectorBuysToday || {}));
  eligible.forEach((row, idx) => {
    row.portfolio_buy_rank = startingBuysToday + idx + 1;
    const sector = row.gics_sector || "SIN_SECTOR";
    const count = (sectorCounts.get(sector) || 0) + 1;
    sectorCounts.set(sector, count);
    row.sector_signal_rank = count;
    row.portfolio_allowed = row.portfolio_buy_rank <= MAX_NEW_BUYS_PER_DAY && row.sector_signal_rank <= MAX_BUYS_PER_SECTOR_PER_DAY;
  });

  for (const row of evaluated) {
    if (row.already_held) {
      row.portfolio_buy_rank = null;
      row.sector_signal_rank = null;
      row.portfolio_allowed = false;
      row.portfolio_limit_reason = "Ya esta abierta en cartera";
    } else if (row.entry_allowed && !row.portfolio_capacity_ok) {
      row.portfolio_buy_rank = null;
      row.sector_signal_rank = null;
      row.portfolio_allowed = false;
      row.portfolio_limit_reason = "Bloqueada: cartera llena, sector saturado o demasiado momentum abierto";
    } else if (!row.entry_allowed) {
      row.portfolio_buy_rank = null;
      row.sector_signal_rank = null;
      row.portfolio_allowed = false;
      row.portfolio_limit_reason = "No es entrada";
    } else if (row.portfolio_allowed) {
      row.portfolio_limit_reason = "Autorizada por cartera";
    } else if (row.portfolio_buy_rank > MAX_NEW_BUYS_PER_DAY) {
      row.portfolio_limit_reason = `Bloqueada: max ${MAX_NEW_BUYS_PER_DAY} compras nuevas al dia (${startingBuysToday} ya ejecutadas)`;
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
        : row.strategy_family === "LEADER_CONTINUATION"
          ? "Entrada lider momentum limitada; tamano max 6%; stop corto si pierde impulso"
        : "Entrada normal con limitada dentro de zona; no perseguir gap"
      : row.already_held
        ? "No duplicar posicion; gestionar stop, objetivo y tiempo maximo"
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
  if (row.already_held) return "YA_EN_CARTERA";
  if (row.hard_invalid) return "INVALIDADA_NO_COMPRAR";
  if (!row.market_ok) return "ESPERAR_MERCADO";
  if (!row.relative_strength_ok) return "ESPERAR_FUERZA_RELATIVA";
  if (!row.volume_confirmation_ok) return "ESPERAR_VOLUMEN";
  if (!row.momentum_quality_ok) return "ESPERAR_CALIDAD_MOMENTUM";
  if (row.entry_allowed && !row.portfolio_capacity_ok) return "ESPERAR_LIMITE_CARTERA";
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
  if (row.already_held) return "El ticker ya esta abierto en la cartera actual";
  if (row.hard_invalid) return "Setup invalidado: ha roto stop/SMA50 o el deterioro es excesivo";
  if (!row.market_ok) return `Filtro mercado activo (${row.market_state || "sin dato"}): no abrir nuevas compras de este tipo`;
  if (row.entry_allowed && !row.portfolio_capacity_ok) return "Entrada valida, pero la cartera ya tiene demasiada exposicion abierta, sectorial o momentum";
  if (row.entry_allowed && !row.portfolio_allowed) return "Entrada tecnicamente valida, pero excede limite diario o limite por sector";
  const reasons = [];
  if (!row.price_zone_ok) reasons.push("precio fuera de zona");
  if (!row.rsi_ok) reasons.push(["BREAKOUT_CONTINUATION", "LEADER_CONTINUATION"].includes(row.strategy_family) ? "RSI fuera de rango momentum" : "RSI no ideal");
  if (!row.trend_ok) reasons.push("precio bajo SMA20/SMA50");
  if (!row.macd_ok) reasons.push(row.macd >= row.macd_signal ? "MACD confirmado pero perdiendo fuerza" : "MACD sin confirmacion");
  if (!row.relative_strength_ok) reasons.push("fuerza relativa insuficiente frente a SPY");
  if (!row.volume_confirmation_ok) reasons.push("volumen insuficiente para confirmar");
  if (!row.momentum_quality_ok) reasons.push("momentum no supera el filtro endurecido");
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
  const usedTickers = new Set(core.concat(breakout).map((row) => row.ticker));
  const leaders = ranked
    .filter((row) => !usedTickers.has(row.ticker) && ruleLeader(row))
    .map((row) => addTradePlan({ ...row, strategy_family: "LEADER_CONTINUATION", Accion: "BUY_LEADER_CONTINUATION", opt_score: leaderOptScore(row) }));

  return core
    .concat(breakout, leaders)
    .sort((a, b) => {
      const priority = { CORE_PULLBACK: 0, BREAKOUT_CONTINUATION: 1, LEADER_CONTINUATION: 2 };
      const pa = priority[a.strategy_family] ?? 9;
      const pb = priority[b.strategy_family] ?? 9;
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
    "score",
    "opt_score",
    "last_close",
    "entry_zone_low",
    "entry_zone_high",
    "invalid_below_price",
    "target_price",
    "risk_reward_ratio",
    "rr_min_rule",
    "rsi14",
    "macd",
    "macd_signal",
    "macd_hist",
    "macd_hist_slope",
    "market_state",
    "market_ok",
    "relative_strength_ok",
    "volume_confirmation_ok",
    "momentum_quality_ok",
    "portfolio_capacity_ok",
    "portfolio_allowed",
    "already_held",
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

function marketDatesFromCharts(charts, startDate, endDate) {
  const dates = new Set();
  for (const chart of charts) {
    for (const row of chart.rows || []) {
      if (row.date > startDate && (!endDate || row.date <= endDate)) dates.add(row.date);
    }
  }
  return [...dates].sort();
}

function rawRowsForDate(charts, date, metaByTicker) {
  const rows = [];
  for (const chart of charts) {
    const history = (chart.rows || []).filter((row) => row.date <= date);
    if (history.length < 220) continue;
    try {
      const feature = computeRawFeature({ ...chart, rows: history }, metaByTicker);
      rows.push({ ...feature, history });
    } catch (_error) {
      // Some symbols can have sparse histories around index changes; skip them for that replay date.
    }
  }
  return rows;
}

function alreadyInAutoLedger(rows, ticker, date) {
  return rows.some((row) => row.ticker === ticker && row.auto_entry_date === date);
}

function deriveAutoLedger(charts, metaByTicker, latestMarketDate) {
  const dates = marketDatesFromCharts(charts, PORTFOLIO_DATA.as_of, latestMarketDate);
  const autoBuyRows = [];
  let latestExecution = [];
  let latestTechnicalEntries = [];
  let latestRecommendations = [];

  for (const date of dates) {
    const replayRaw = rawRowsForDate(charts, date, metaByTicker);
    if (!replayRaw.length) continue;

    const replayRanked = addScoresAndSetups(replayRaw);
    const replayCandidates = selectCandidates(replayRanked);
    const replayMarketRegime = marketRegimeFromRows(replayRaw);
    const replayPortfolio = buildPortfolioSnapshot(replayRaw, date, autoBuyRows);
    const replayContext = {
      ...scannerContextFromPortfolio(replayPortfolio),
      marketRegime: replayMarketRegime,
    };
    const replayExecution = executionFilter(replayCandidates, replayContext);
    const replayRecommendations = replayExecution
      .filter((row) => row.portfolio_allowed)
      .map((row) => ({ ...compactRow(row), auto_entry_date: date }));
    const replayTechnicalEntries = replayExecution
      .filter((row) => row.entry_allowed)
      .map((row) => ({ ...compactRow(row), auto_entry_date: date }));

    for (const row of replayRecommendations) {
      if (alreadyInAutoLedger(autoBuyRows, row.ticker, date)) continue;
      autoBuyRows.push(row);
    }

    if (date === latestMarketDate) {
      latestExecution = replayExecution;
      latestRecommendations = replayRecommendations;
      latestTechnicalEntries = replayTechnicalEntries;
    }
  }

  return {
    autoBuyRows,
    latestExecution,
    latestRecommendations,
    latestTechnicalEntries,
  };
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
  const latestMarketDate = raw.map((row) => row.run_date).sort().at(-1) || null;
  const marketRegime = marketRegimeFromRows(raw);
  const chartsBySymbol = new Map(ok.map((chart) => [chart.symbol, chart]));
  const portfolioRows = raw.map((row) => ({
    ...row,
    history: chartsBySymbol.get(row.ticker)?.rows || [],
  }));
  const replay = deriveAutoLedger(ok, metaByTicker, latestMarketDate);
  const portfolio = buildPortfolioSnapshot(portfolioRows, latestMarketDate, replay.autoBuyRows);
  const portfolioContext = {
    ...scannerContextFromPortfolio(portfolio),
    marketRegime,
  };
  const execution = replay.latestExecution.length ? replay.latestExecution : executionFilter(candidates, portfolioContext);
  const recommendations = replay.latestRecommendations.length
    ? replay.latestRecommendations
    : execution.filter((row) => row.portfolio_allowed).map(compactRow);
  const technicalEntries = replay.latestTechnicalEntries.length
    ? replay.latestTechnicalEntries
    : execution.filter((row) => row.entry_allowed).map(compactRow);
  const watch = execution.filter((row) => !row.portfolio_allowed).slice(0, 20).map(compactRow);

  return {
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
    universe_source: source,
    universe_count: universe.length,
    downloaded_count: ok.length,
    failed_count: failed.length,
    failed: failed.slice(0, 20),
    latest_market_date: latestMarketDate,
    market_regime: marketRegime,
    // Solo para el tracker de paper trading: reutiliza los precios ya
    // descargados. La API nunca lo serializa (pesa megas).
    charts: options.includeCharts ? ok : undefined,
    dashboard: {
      candidates_total: candidates.length,
      core_count: candidates.filter((row) => row.strategy_family === "CORE_PULLBACK").length,
      breakout_count: candidates.filter((row) => row.strategy_family === "BREAKOUT_CONTINUATION").length,
      leader_count: candidates.filter((row) => row.strategy_family === "LEADER_CONTINUATION").length,
      technical_entry_count: technicalEntries.length,
      portfolio_entry_count: recommendations.length,
      open_positions_count: portfolio.summary.open_positions,
      buys_today_count: portfolioContext.buysTodayCount,
      hot_momentum_count: ranked.filter((row) => row.setup_type === "HOT_MOMENTUM").length,
      pullback_count: ranked.filter((row) => row.setup_type === "PULLBACK_IN_TREND").length,
      near_breakout_count: ranked.filter((row) => row.setup_type === "NEAR_BREAKOUT").length,
    },
    recommendations,
    technical_entries: technicalEntries,
    watch,
    portfolio,
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
      max_open_positions: MAX_OPEN_POSITIONS,
      max_open_positions_per_sector: MAX_OPEN_POSITIONS_PER_SECTOR,
      max_open_momentum_positions: MAX_OPEN_MOMENTUM_POSITIONS,
      min_core_rr: MIN_CORE_EXECUTION_RR,
      min_momentum_rr: MIN_MOMENTUM_EXECUTION_RR,
      min_leader_rr: LEADER_MIN_EXECUTION_RR,
      market_state: marketRegime.state,
      note: "No compra a mercado: usar entry_zone_high como limite maximo.",
    },
  };
}

module.exports = {
  runScanner,
  computeRawFeature,
  addScoresAndSetups,
  compactRow,
  MAX_NEW_BUYS_PER_DAY,
  MAX_BUYS_PER_SECTOR_PER_DAY,
};
