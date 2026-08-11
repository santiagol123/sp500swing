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

const DEFAULT_PROFILE = {
  strategyId: "chatgpt_sp500",
  convictionLabel: "S&P 500",
  benchmark: "SPY",
  executionProfile: "chatgpt_sp500_insider_conviction",
  ruleSource: "chat_pasted_text_insider_conviction",
};

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
  const reasons = rejectionReasons(signal, today, freshnessLimit);
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
    authorized: false,
    opt_score: score,
    meta: {
      ...(signal.meta || {}),
      conviction_score: score,
      conviction_filing_date: filingDate,
      conviction_filing_age_days: filingAge,
      conviction_rejection_reasons: reasons,
      target_holding_sessions: TARGET_HOLDING_SESSIONS,
      benchmark: profile.benchmark,
      universe_label: profile.convictionLabel,
      rule_source: profile.ruleSource,
    },
  };
}

function authorize(signals) {
  let authorizedCount = 0;

  for (const signal of signals) {
    if (signal.action !== "COMPRAR_LIMITADA") continue;
    if (authorizedCount < MAX_AUTHORIZED_BUYS) {
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

  authorize(mapped);

  const signals = mapped;
  const watch = mapped.filter((signal) => !signal.authorized && signal.action !== "COMPRAR_LIMITADA").slice(0, 25);
  const buyableSignals = signals.filter((signal) => signal.action === "COMPRAR_LIMITADA" || signal.authorized);
  const authorizedSignals = signals.filter((signal) => signal.authorized);

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
    },
    extra: {
      ...(base.extra || {}),
      rules: {
        ...(base.extra?.rules || {}),
        min_conviction_value_usd: MIN_CONVICTION_VALUE_USD,
        min_conviction_insiders: MIN_CONVICTION_INSIDERS,
        min_single_senior_value_usd: MIN_SINGLE_SENIOR_VALUE_USD,
        max_authorized_buys: MAX_AUTHORIZED_BUYS,
        max_new_buys_per_day: MAX_AUTHORIZED_BUYS,
        max_buys_per_sector_per_day: null,
        signal_filing_fresh_days: SIGNAL_FILING_FRESH_DAYS,
        bootstrap_filing_fresh_days: BOOTSTRAP_FILING_FRESH_DAYS,
        target_holding_sessions: TARGET_HOLDING_SESSIONS,
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
