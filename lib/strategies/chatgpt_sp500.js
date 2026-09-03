// Estrategia 3: orden programada ChatGPT S&P 500.
//
// Automatiza la regla definida en el chat adjunto: usar compras fuertes de
// insiders como factor de seleccion, no como compra automatica ingenua.

const insiderTotal = require("./insider_total");
const { clip } = require("../indicators");

const MIN_CONVICTION_VALUE_USD = Number(process.env.CHATGPT_SP500_MIN_VALUE_USD || 250000);
const MIN_CONVICTION_INSIDERS = Number(process.env.CHATGPT_SP500_MIN_INSIDERS || 2);
const MIN_SINGLE_SENIOR_VALUE_USD = Number(process.env.CHATGPT_SP500_MIN_SINGLE_SENIOR_VALUE_USD || 500000);
const SIGNAL_FILING_FRESH_DAYS = Number(process.env.CHATGPT_SP500_SIGNAL_FILING_FRESH_DAYS || 20);
const BOOTSTRAP_FILING_FRESH_DAYS = Number(process.env.CHATGPT_SP500_BOOTSTRAP_FILING_FRESH_DAYS || 90);
const MAX_AUTHORIZED_BUYS = Number(process.env.CHATGPT_SP500_MAX_AUTHORIZED_BUYS || 12);
const TARGET_HOLDING_SESSIONS = Number(process.env.CHATGPT_SP500_MAX_HOLD_DAYS || 5);
const TECHNICAL_MAX_VOLATILITY_20D = pctConfig("CHATGPT_SP500_MAX_VOLATILITY_20D", 0.60);
const TECHNICAL_MAX_ENTRY_GAP_PCT = pctConfig("CHATGPT_SP500_MAX_ENTRY_GAP_PCT", 0.03);
const TECHNICAL_MIN_RSI = Number(process.env.CHATGPT_SP500_MIN_RSI || 45);
const TECHNICAL_WEAK_REBOUND_MIN_VALUE_USD = Number(process.env.CHATGPT_SP500_WEAK_REBOUND_MIN_VALUE_USD || 1_000_000);
const HIGH_VOL_EXCEPTION_MIN_SCORE = Number(process.env.CHATGPT_SP500_HIGH_VOL_EXCEPTION_MIN_SCORE || 94);
const HIGH_VOL_EXCEPTION_MIN_VALUE_USD = Number(process.env.CHATGPT_SP500_HIGH_VOL_EXCEPTION_MIN_VALUE_USD || 5_000_000);
const HIGH_VOL_EXCEPTION_MIN_INSIDERS = Number(process.env.CHATGPT_SP500_HIGH_VOL_EXCEPTION_MIN_INSIDERS || 3);
const HIGH_VOL_EXCEPTION_SIZE_PCT = pctConfig("CHATGPT_SP500_HIGH_VOL_EXCEPTION_SIZE_PCT", 0.03);

const DEFAULT_PROFILE = {
  strategyId: "chatgpt_sp500",
  convictionLabel: "S&P 500",
  benchmark: "SPY",
  executionProfile: "chatgpt_sp500_insider_conviction",
  ruleSource: "chat_pasted_text_insider_conviction",
};

function pctConfig(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value > 1 ? value / 100 : value;
}

function dayDiff(a, b) {
  return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

function seniorityTitle(title = "") {
  const text = String(title || "").toLowerCase();
  if (/\b(ceo|chief executive|cfo|chief financial|coo|chief operating|founder|co-founder)\b/.test(text)) return "ceo_cfo";
  if (/\b(chief|president|officer|treasurer|controller|evp|svp|vp)\b/.test(text)) return "officer";
  if (/\b(chairman|chair|director)\b/.test(text)) return "director";
  if (/10%|beneficial owner/.test(text)) return "ten_percent";
  return "other";
}

function insiderSeniority(insider = {}) {
  if (insider.is_officer && /\b(ceo|chief executive|cfo|chief financial)\b/i.test(insider.title || "")) return "ceo_cfo";
  if (insider.is_officer) return "officer";
  if (insider.is_director) return "director";
  return seniorityTitle(insider.title);
}

function seniorityScore(insiders = []) {
  const levels = insiders.map(insiderSeniority);
  if (levels.includes("ceo_cfo")) return 1;
  if (levels.includes("officer")) return 0.85;
  if (levels.includes("director")) return 0.70;
  return 0.15;
}

function lastFilingDate(signal) {
  const dates = [
    signal.meta?.last_filing,
    signal.meta?.dataroma_flow?.latest_filing_date,
    ...(signal.meta?.insiders || []).map((row) => row.filing_date),
  ].filter(Boolean);
  return dates.sort().at(-1) || null;
}

function hasTenB5Plan(signal) {
  return Boolean(signal.meta?.has_10b5_1_plan || (signal.meta?.insiders || []).some((row) => row.has_10b5_1_plan));
}

function isSingleSeniorMaterial(signal) {
  const valueUsd = Number(signal.meta?.total_value_usd || 0);
  const insiderCount = Number(signal.meta?.insider_count || 0);
  const seniority = seniorityScore(signal.meta?.insiders || []);
  return insiderCount === 1 && valueUsd >= MIN_SINGLE_SENIOR_VALUE_USD && seniority >= 0.85;
}

function maxAuthorizedBuys(profile = DEFAULT_PROFILE) {
  const value = Number(profile.maxAuthorizedBuys || MAX_AUTHORIZED_BUYS);
  return Number.isFinite(value) && value > 0 ? value : MAX_AUTHORIZED_BUYS;
}

function profileMinTotalValueUsd(profile = DEFAULT_PROFILE) {
  const value = Number(profile.minTotalValueUsd || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function technicalValue(signal, key) {
  const value = Number(signal.meta?.[key]);
  return Number.isFinite(value) ? value : null;
}

function isHighVolException(signal, score) {
  const valueUsd = Number(signal.meta?.total_value_usd || 0);
  const insiderCount = Number(signal.meta?.insider_count || 0);
  const rsi = technicalValue(signal, "rsi14");
  const gap = technicalValue(signal, "entry_gap_1d");
  const aboveSma20 = signal.meta?.above_sma20 === true;

  return (
    score >= HIGH_VOL_EXCEPTION_MIN_SCORE &&
    valueUsd >= HIGH_VOL_EXCEPTION_MIN_VALUE_USD &&
    insiderCount >= HIGH_VOL_EXCEPTION_MIN_INSIDERS &&
    aboveSma20 &&
    (!Number.isFinite(rsi) || rsi >= TECHNICAL_MIN_RSI) &&
    (!Number.isFinite(gap) || gap <= TECHNICAL_MAX_ENTRY_GAP_PCT)
  );
}

function technicalRiskReview(signal, { profile = DEFAULT_PROFILE, score = 0 } = {}) {
  const reasons = [];
  const valueUsd = Number(signal.meta?.total_value_usd || 0);
  const rsi = technicalValue(signal, "rsi14");
  const volatility = technicalValue(signal, "volatility_20d");
  const gap = technicalValue(signal, "entry_gap_1d");
  const belowSma20 = signal.meta?.above_sma20 === false;
  const highVol = Number.isFinite(volatility) && volatility > TECHNICAL_MAX_VOLATILITY_20D;
  const highVolException = highVol && isHighVolException(signal, score);
  const minValueUsd = profileMinTotalValueUsd(profile);

  if (minValueUsd && valueUsd < minValueUsd) {
    reasons.push(`importe total < ${minValueUsd.toLocaleString("en-US")} USD`);
  }
  if (highVol && !highVolException) {
    reasons.push(`volatilidad 20d ${(volatility * 100).toFixed(0)}% > ${(TECHNICAL_MAX_VOLATILITY_20D * 100).toFixed(0)}%`);
  }
  if (
    belowSma20 &&
    Number.isFinite(rsi) &&
    rsi < TECHNICAL_MIN_RSI &&
    (highVol || valueUsd < TECHNICAL_WEAK_REBOUND_MIN_VALUE_USD)
  ) {
    reasons.push(`rebote debil: RSI ${rsi.toFixed(1)} bajo SMA20`);
  }
  if (Number.isFinite(gap) && gap > TECHNICAL_MAX_ENTRY_GAP_PCT) {
    reasons.push(`gap de entrada ${(gap * 100).toFixed(1)}% > ${(TECHNICAL_MAX_ENTRY_GAP_PCT * 100).toFixed(1)}%`);
  }

  const sizePct =
    highVolException && Number.isFinite(Number(signal.size_pct))
      ? Math.min(Number(signal.size_pct), HIGH_VOL_EXCEPTION_SIZE_PCT)
      : signal.size_pct;

  return {
    reasons,
    high_vol_exception: highVolException,
    size_pct: sizePct,
  };
}

function convictionScore(signal, today) {
  const insiders = signal.meta?.insiders || [];
  const valueUsd = Number(signal.meta?.total_value_usd || 0);
  const insiderCount = Number(signal.meta?.insider_count || 0);
  const filingDate = lastFilingDate(signal);
  const filingFreshness = filingDate ? clip(1 - dayDiff(today, filingDate) / SIGNAL_FILING_FRESH_DAYS, 0, 1) : 0.35;
  const value = clip(Math.log10(Math.max(valueUsd, 1) / MIN_CONVICTION_VALUE_USD) / Math.log10(30), 0, 1);
  const cluster = clip((insiderCount - MIN_CONVICTION_INSIDERS + 1) / 4, 0, 1);
  const seniority = seniorityScore(insiders);
  const flow = signal.meta?.dataroma_flow?.net_value_usd > 0 ? 0.15 : 0;
  const raw = 0.30 * value + 0.25 * cluster + 0.25 * seniority + 0.20 * filingFreshness + flow;
  return Math.round((55 + 40 * clip(raw, 0, 1)) * 10) / 10;
}

function rejectionReasons(signal, today, freshnessLimit) {
  const reasons = [];
  const valueUsd = Number(signal.meta?.total_value_usd || 0);
  const insiderCount = Number(signal.meta?.insider_count || 0);
  const filingDate = lastFilingDate(signal);
  const filingAge = filingDate ? dayDiff(today, filingDate) : null;
  const seniority = seniorityScore(signal.meta?.insiders || []);
  const singleSeniorMaterial = isSingleSeniorMaterial(signal);

  if (hasTenB5Plan(signal)) reasons.push("posible plan 10b5-1/programado");
  if (insiderCount < MIN_CONVICTION_INSIDERS && !singleSeniorMaterial) {
    reasons.push(
      `menos de ${MIN_CONVICTION_INSIDERS} insiders y compra senior individual < ${MIN_SINGLE_SENIOR_VALUE_USD.toLocaleString("en-US")} USD`,
    );
  }
  if (valueUsd < MIN_CONVICTION_VALUE_USD) reasons.push(`importe < ${MIN_CONVICTION_VALUE_USD.toLocaleString("en-US")} USD`);
  if (seniority < 0.70) reasons.push("sin CEO/CFO/officer/director claro");
  if (!filingDate) reasons.push("sin fecha de publicacion Form 4/Dataroma");
  if (filingAge != null && filingAge > freshnessLimit) reasons.push(`filing antiguo (${Math.round(filingAge)} dias)`);
  if (signal.action !== "COMPRAR_LIMITADA" && signal.action !== "COMPRAR_BOOTSTRAP") reasons.push(`accion base ${signal.action}`);

  return reasons;
}

function retagSignal(signal, { today, freshnessLimit, profile = DEFAULT_PROFILE }) {
  const filingDate = lastFilingDate(signal);
  const filingAge = filingDate ? Math.round(dayDiff(today, filingDate)) : null;
  const score = convictionScore(signal, today);
  const baseReasons = rejectionReasons(signal, today, freshnessLimit);
  const technicalReview = technicalRiskReview(signal, { profile, score });
  const reasons = baseReasons.concat(technicalReview.reasons);
  const accepted = reasons.length === 0;
  const valueUsd = Number(signal.meta?.total_value_usd || 0);
  const insiderCount = Number(signal.meta?.insider_count || 0);
  const singleSeniorMaterial = isSingleSeniorMaterial(signal);
  const actorText = singleSeniorMaterial ? "1 insider senior" : `${insiderCount} insiders senior/materiales`;
  const verbText = singleSeniorMaterial ? "compro" : "compraron";

  return {
    ...signal,
    strategy: profile.strategyId,
    family: "INSIDER_CONVICTION",
    action: accepted ? "COMPRAR_LIMITADA" : "ESPERAR_FILTRO_CONVICCION",
    reason: accepted
      ? `Conviccion insider ${profile.convictionLabel}: ${actorText} ${verbText} ${Math.round(valueUsd).toLocaleString("en-US")} USD; filing ${filingDate}${filingAge == null ? "" : ` (${filingAge} dias)`}.`
      : `${signal.reason} | filtro ${profile.convictionLabel}: ${reasons.join("; ")}`,
    plan: accepted
      ? `Entrada tras publicacion del Form 4/Dataroma; cerrar por tiempo a ${TARGET_HOLDING_SESSIONS} sesiones si no toca stop/TP antes.`
      : "Solo seguimiento hasta cumplir conviccion, frescura e importe.",
    size_pct: accepted ? technicalReview.size_pct : 0,
    authorized: false,
    opt_score: score,
    meta: {
      ...(signal.meta || {}),
      conviction_score: score,
      conviction_filing_date: filingDate,
      conviction_filing_age_days: filingAge,
      conviction_rejection_reasons: reasons,
      conviction_base_rejection_reasons: baseReasons,
      technical_risk_rejection_reasons: technicalReview.reasons,
      high_vol_exception: technicalReview.high_vol_exception,
      target_holding_sessions: TARGET_HOLDING_SESSIONS,
      benchmark: profile.benchmark,
      universe_label: profile.convictionLabel,
      rule_source: profile.ruleSource,
    },
  };
}

function authorize(signals, limit = MAX_AUTHORIZED_BUYS) {
  let authorizedCount = 0;

  for (const signal of signals) {
    if (signal.action !== "COMPRAR_LIMITADA") continue;
    if (authorizedCount < limit) {
      signal.authorized = true;
      authorizedCount += 1;
    } else {
      signal.action = "ESPERAR_LIMITE_CARTERA";
      signal.reason = `${signal.reason} | bloqueada por limite maximo de cartera`;
      signal.size_pct = 0;
    }
  }
}

async function run(options = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const freshnessLimit = options.bootstrapSignals ? BOOTSTRAP_FILING_FRESH_DAYS : SIGNAL_FILING_FRESH_DAYS;
  const profile = {
    ...DEFAULT_PROFILE,
    ...(options.profile || {}),
  };
  const base = await insiderTotal.run({ ...options, skipAuthorization: true });
  const mapped = (base.signals || [])
    .map((signal) => retagSignal(signal, { today, freshnessLimit, profile }))
    .sort((a, b) => b.opt_score - a.opt_score);
  const authorizedLimit = maxAuthorizedBuys(profile);

  authorize(mapped, authorizedLimit);

  const signals = mapped;
  const watch = mapped.filter((signal) => !signal.authorized && signal.action !== "COMPRAR_LIMITADA").slice(0, 25);
  const buyableSignals = signals.filter((signal) => signal.action === "COMPRAR_LIMITADA" || signal.authorized);
  const authorizedSignals = signals.filter((signal) => signal.authorized);
  const technicalRejectedSignals = signals.filter((signal) => (signal.meta?.technical_risk_rejection_reasons || []).length);

  return {
    ...base,
    signals,
    watch,
    diagnostics: {
      ...(base.diagnostics || {}),
      candidates_total: mapped.length,
      technical_entry_count: buyableSignals.length,
      portfolio_entry_count: authorizedSignals.length,
      signals_fresh: buyableSignals.length,
      source_strategy: "insider_total",
      execution_profile: profile.executionProfile,
      conviction_candidates: mapped.length,
      conviction_buyable: buyableSignals.length,
      conviction_authorized: authorizedSignals.length,
      conviction_watch: watch.length,
      technical_risk_rejected: technicalRejectedSignals.length,
      technical_risk_rejected_tickers: technicalRejectedSignals.map((signal) => signal.ticker),
    },
    extra: {
      ...(base.extra || {}),
      rules: {
        ...(base.extra?.rules || {}),
        min_conviction_value_usd: MIN_CONVICTION_VALUE_USD,
        min_conviction_insiders: MIN_CONVICTION_INSIDERS,
        min_single_senior_value_usd: MIN_SINGLE_SENIOR_VALUE_USD,
        max_authorized_buys: authorizedLimit,
        max_new_buys_per_day: authorizedLimit,
        max_buys_per_sector_per_day: null,
        signal_filing_fresh_days: SIGNAL_FILING_FRESH_DAYS,
        bootstrap_filing_fresh_days: BOOTSTRAP_FILING_FRESH_DAYS,
        target_holding_sessions: TARGET_HOLDING_SESSIONS,
        max_volatility_20d: TECHNICAL_MAX_VOLATILITY_20D,
        min_rsi: TECHNICAL_MIN_RSI,
        max_entry_gap_pct: TECHNICAL_MAX_ENTRY_GAP_PCT,
        weak_rebound_min_value_usd: TECHNICAL_WEAK_REBOUND_MIN_VALUE_USD,
        profile_min_total_value_usd: profileMinTotalValueUsd(profile),
        high_vol_exception_min_score: HIGH_VOL_EXCEPTION_MIN_SCORE,
        high_vol_exception_min_value_usd: HIGH_VOL_EXCEPTION_MIN_VALUE_USD,
        high_vol_exception_min_insiders: HIGH_VOL_EXCEPTION_MIN_INSIDERS,
        high_vol_exception_size_pct: HIGH_VOL_EXCEPTION_SIZE_PCT,
        benchmark: profile.benchmark,
        universe_label: profile.convictionLabel,
        note:
          `Automatiza el chat: compras Form 4 codigo P/Dataroma como evento de 1-5 sesiones, priorizando CEO/CFO/officers/directors, clusters, importe material y filings recientes.`,
      },
    },
  };
}

module.exports = {
  id: "chatgpt_sp500",
  label: "ChatGPT SP500",
  description:
    "Compras fuertes de insiders del S&P 500: Form 4 codigo P/Dataroma, clusters, seniority, importe material y salida temporal a 5 sesiones.",
  signal_source: "SEC EDGAR + Dataroma + Yahoo Finance",
  run,
  convictionScore,
  rejectionReasons,
  retagSignal,
  TARGET_HOLDING_SESSIONS,
};
