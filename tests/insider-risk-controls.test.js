const test = require("node:test");
const assert = require("node:assert/strict");

const {
  openNewPositions,
  pruneInvalidTimingPositions,
  reentryBlock,
  signalTimingBlock,
  staleSignalEntryBlock,
  stampSignalDetection,
  stopReentryCooldownBlock,
  updateRejectedSignalObservations,
} = require("../lib/papertrading");
const { rejectionReasons, technicalRiskReview } = require("../lib/strategies/chatgpt_sp500");

function workspace() {
  return {
    portfolio: {
      initial_equity: 100000,
      max_open_positions: 12,
      max_new_positions_per_day: 12,
      max_positions_per_sector: 12,
      max_loss_pct: 0.02,
      require_new_insider_event_after_exit: true,
      stop_reentry_cooldown_days: 7,
      max_entries_per_ticker: 2,
      entry_frequency_lookback_days: 30,
      post_stop_require_technical_recovery: true,
      post_stop_reentry_max_size_pct: 0.05,
      max_signal_age_sessions: 3,
      stale_signal_min_rsi: 45,
      stale_signal_max_size_pct: 0.05,
    },
  };
}

function state(overrides = {}) {
  return {
    cash: 100000,
    positions: [],
    trades: [],
    equity_curve: [],
    tracked_days: 0,
    ...overrides,
  };
}

function signal(overrides = {}) {
  return {
    ticker: "TEST",
    name: "Test Corp",
    sector: "Industrials",
    family: "INSIDER_CONVICTION",
    authorized: true,
    action: "COMPRAR_LIMITADA",
    reason: "Compra insider",
    size_pct: 0.05,
    invalid_below_price: 90,
    target_price: 112,
    entry_zone_high: 105,
    meta: {
      last_filing: "2026-09-17",
      conviction_filing_date: "2026-09-17",
      insiders: [{ name: "ALICE", filing_date: "2026-09-17" }],
      first_detected_at: "2026-09-17T14:00:00.000Z",
    },
    ...overrides,
  };
}

test("preserves first detection for the same event and resets it for a new filing", () => {
  const previous = signal({
    meta: {
      last_filing: "2026-09-17",
      conviction_filing_date: "2026-09-17",
      first_detected_at: "2026-09-17T12:00:00.000Z",
    },
  });
  const sameEvent = signal();
  stampSignalDetection([sameEvent], [previous], "2026-09-17T15:00:00.000Z");
  assert.equal(sameEvent.meta.first_detected_at, "2026-09-17T12:00:00.000Z");

  const newEvent = signal({
    meta: { last_filing: "2026-09-18", conviction_filing_date: "2026-09-18" },
  });
  stampSignalDetection([newEvent], [previous], "2026-09-18T15:00:00.000Z");
  assert.equal(newEvent.meta.first_detected_at, "2026-09-18T15:00:00.000Z");
});

test("blocks an entry before publication and allows the first executable market date", () => {
  const charts = new Map([
    [
      "TEST",
      {
        symbol: "TEST",
        rows: [
          { date: "2026-09-16", close_raw: 100, high: 101, low: 99 },
          { date: "2026-09-17", close_raw: 101, high: 102, low: 100 },
        ],
      },
    ],
  ]);
  const portfolio = state();
  const blockedTiming = [];
  const earlySignal = signal();

  const early = openNewPositions(portfolio, [earlySignal], charts, workspace(), "2026-09-16", [], blockedTiming);
  assert.equal(early.length, 0);
  assert.equal(blockedTiming.length, 1);
  assert.equal(earlySignal.action, "ESPERAR_PRIMER_PRECIO_EJECUTABLE");

  const onTime = openNewPositions(portfolio, [signal()], charts, workspace(), "2026-09-17", [], []);
  assert.equal(onTime.length, 1);
  assert.equal(onTime[0].entry_date, "2026-09-17");
});

test("blocks a signal first detected after the New York close", () => {
  const late = signal({
    meta: {
      last_filing: "2026-09-17",
      conviction_filing_date: "2026-09-17",
      first_detected_at: "2026-09-17T20:30:00.000Z",
    },
  });
  const block = signalTimingBlock(late, "2026-09-17", workspace());
  assert.match(block.reason, /tras el cierre/);
});

test("flags accelerated declines under both moving averages", () => {
  const review = technicalRiskReview({
    size_pct: 0.07,
    meta: {
      total_value_usd: 5_000_000,
      above_sma20: false,
      above_sma50: false,
      ret_1w: -0.06,
      ret_1m: -0.08,
      rsi14: 40,
      volatility_20d: 0.25,
      entry_gap_1d: 0,
    },
  });
  assert.equal(review.falling_knife, true);
  assert.ok(review.reasons.some((reason) => reason.includes("caida acelerada")));

  const controlledPullback = technicalRiskReview({
    size_pct: 0.07,
    meta: {
      total_value_usd: 5_000_000,
      above_sma20: false,
      above_sma50: false,
      ret_1w: -0.04,
      ret_1m: -0.09,
      rsi14: 34,
      volatility_20d: 0.25,
      entry_gap_1d: 0,
    },
  });
  assert.equal(controlledPullback.falling_knife, false);

  const oversoldPullback = technicalRiskReview({
    size_pct: 0.07,
    meta: {
      total_value_usd: 5_000_000,
      above_sma20: false,
      above_sma50: false,
      ret_1w: -0.02,
      ret_1m: -0.08,
      rsi14: 26,
      volatility_20d: 0.25,
      entry_gap_1d: 0,
    },
  });
  assert.equal(oversoldPullback.falling_knife, true);
});

test("requires full technical recovery after a losing stop and caps reentry size", () => {
  const stoppedState = state({
    trades: [
      {
        ticker: "TEST",
        entry_date: "2026-09-01",
        entry_price: 100,
        exit_date: "2026-09-04",
        exit_reason: "STOP",
        pnl: -200,
        pnl_pct: -0.021,
        signal_meta: { insiders: [{ name: "ALICE" }] },
      },
    ],
  });
  const chart = {
    rows: [
      { date: "2026-09-07", close_raw: 96, high: 97 },
      { date: "2026-09-08", close_raw: 96, high: 97 },
      { date: "2026-09-09", close_raw: 97, high: 98 },
      { date: "2026-09-10", close_raw: 97, high: 98 },
      { date: "2026-09-11", close_raw: 96, high: 98 },
      { date: "2026-09-14", close_raw: 97, high: 98 },
      { date: "2026-09-15", close_raw: 97, high: 98 },
      { date: "2026-09-16", close_raw: 98, high: 99 },
      { date: "2026-09-17", close_raw: 99, high: 100 },
    ],
  };
  const sameInsider = signal({ meta: { ...signal().meta, above_sma20: true } });
  assert.ok(stopReentryCooldownBlock(sameInsider, stoppedState, workspace(), chart, "2026-09-17"));

  const differentInsider = signal({
    size_pct: 0.10,
    meta: { ...signal().meta, above_sma20: false, insiders: [{ name: "ALICE" }, { name: "BOB" }] },
  });
  assert.ok(stopReentryCooldownBlock(differentInsider, stoppedState, workspace(), chart, "2026-09-17"));

  const recoveredChart = { rows: [...chart.rows.slice(0, -1), { date: "2026-09-17", close_raw: 101, high: 102 }] };
  const recoveredSignal = signal({ size_pct: 0.10, meta: { ...signal().meta, above_sma20: true } });
  assert.equal(stopReentryCooldownBlock(recoveredSignal, stoppedState, workspace(), recoveredChart, "2026-09-17"), null);
  assert.equal(recoveredSignal.size_pct, 0.05);
  assert.equal(recoveredSignal.meta.post_stop_technical_recovery, true);
});

test("limits a ticker to two entries in a rolling 30 day window", () => {
  const portfolio = state({
    last_market_date: "2026-09-20",
    trades: [
      { ticker: "TEST", entry_date: "2026-09-02", exit_date: "2026-09-05", exit_reason: "LIMITE_DIAS" },
      { ticker: "TEST", entry_date: "2026-09-10", exit_date: "2026-09-14", exit_reason: "STOP" },
    ],
  });
  const freshEvent = signal({
    meta: { ...signal().meta, last_filing: "2026-09-19", conviction_filing_date: "2026-09-19" },
  });
  const block = reentryBlock(freshEvent, portfolio, workspace(), "2026-09-20");
  assert.equal(block.action, "ESPERAR_LIMITE_REENTRADAS");
});

test("blocks stale signals without recovery and halves confirmed stale entries", () => {
  const chart = {
    rows: [
      { date: "2026-09-17", close_raw: 100 },
      { date: "2026-09-18", close_raw: 99 },
      { date: "2026-09-21", close_raw: 98 },
      { date: "2026-09-22", close_raw: 97 },
      { date: "2026-09-23", close_raw: 98 },
    ],
  };
  const stale = signal({ meta: { ...signal().meta, above_sma20: false, rsi14: 40 } });
  assert.ok(staleSignalEntryBlock(stale, chart, "2026-09-23", workspace()));

  const recovered = signal({ size_pct: 0.10, meta: { ...signal().meta, above_sma20: true, rsi14: 50 } });
  assert.equal(staleSignalEntryBlock(recovered, chart, "2026-09-23", workspace()), null);
  assert.equal(recovered.size_pct, 0.05);
  assert.equal(recovered.meta.stale_signal_technical_confirmation, true);
});

test("uses recently published purchases instead of accumulated cluster value", () => {
  const accumulated = signal({
    meta: {
      ...signal().meta,
      total_value_usd: 2_000_000,
      insider_count: 2,
      last_filing: "2026-09-17",
      insiders: [
        { name: "ALICE", title: "CEO", value_usd: 1_900_000, filing_date: "2026-09-01" },
        { name: "BOB", title: "Director", value_usd: 100_000, filing_date: "2026-09-17" },
      ],
    },
  });
  const reasons = rejectionReasons(accumulated, "2026-09-17", 20);
  assert.ok(reasons.some((reason) => reason.includes("importe publicado")));
});

test("tracks rejected signals in shadow mode through the five day risk rules", () => {
  const portfolio = state();
  const rejected = signal({
    authorized: false,
    action: "ESPERAR_CONFIRMACION_REENTRADA",
    meta: { ...signal().meta, reentry_blocked: true },
  });
  const firstCharts = new Map([
    ["TEST", { symbol: "TEST", rows: [{ date: "2026-09-17", close_raw: 100, low: 99, high: 101 }] }],
  ]);
  const added = updateRejectedSignalObservations(portfolio, [rejected], firstCharts, "2026-09-17", workspace());
  assert.equal(added.length, 1);
  assert.equal(portfolio.rejected_signal_observations[0].status, "TRACKING");

  const stoppedCharts = new Map([
    [
      "TEST",
      {
        symbol: "TEST",
        rows: [
          { date: "2026-09-17", close_raw: 100, low: 99, high: 101 },
          { date: "2026-09-18", close_raw: 97.5, low: 97, high: 100 },
        ],
      },
    ],
  ]);
  updateRejectedSignalObservations(portfolio, [], stoppedCharts, "2026-09-18", workspace());
  assert.equal(portfolio.rejected_signal_observations[0].status, "COMPLETE");
  assert.equal(portfolio.rejected_signal_observations[0].exit_reason, "SHADOW_STOP");
  assert.equal(portfolio.rejected_signal_observations[0].return_pct, -0.02);
});

test("removes an open position whose event was published after its entry", () => {
  const portfolio = state({
    cash: 9000,
    positions: [{ ticker: "ADC", entry_date: "2026-09-22", signal_event_date: "2026-09-23", cost_basis: 1000 }],
  });
  const pruned = pruneInvalidTimingPositions(portfolio, workspace());
  assert.equal(pruned.length, 1);
  assert.equal(portfolio.positions.length, 0);
  assert.equal(portfolio.cash, 10000);
});
