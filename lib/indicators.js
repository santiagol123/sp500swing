// Funciones matematicas puras compartidas por todas las estrategias.
// Extraidas de lib/scanner.js sin cambiar el comportamiento.

function finite(value, fallback = null) {
  // null, undefined y "" van al fallback explicitamente: Number("") es 0, que
  // pasaria el test de finitud y colaria un cero como si fuera un dato real.
  if (value === null || value === undefined || value === "") return fallback;
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

module.exports = {
  finite,
  clip,
  mean,
  std,
  sma,
  pctReturn,
  maxLast,
  emaSeries,
  rsi14,
  macd,
  dailyReturns,
  pctRanks,
};
