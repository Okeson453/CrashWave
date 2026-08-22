import {
  detectAnomalies,
  clearAnomalyCooldowns,
  formatAnomalyFlags,
} from '../../../src/analytics/learning/anomaly';
import { AnomalyInput } from '../../../src/analytics/learning/anomaly';
import { BetOutcomeRecord, HitRateMetrics, DrawdownMetrics, StreakMetrics, LatencyMetrics, CashOutSuccessMetrics } from '../../../src/analytics/types';

function makeOutcomes(pattern: ('win' | 'loss' | 'failed' | 'unknown')[]): BetOutcomeRecord[] {
  return pattern.map((outcome, i) => ({
    betId: `b-${i}`,
    roundId: `r-${i}`,
    dailyKey: '2024-01-01',
    timestamp: new Date(2024, 0, 1, 0, i).toISOString(),
    outcome,
    pnl: outcome === 'win' ? 210 : outcome === 'loss' ? -700 : 0,
    stake: 700,
    target: 1.30,
    cashOutMultiplier: outcome === 'win' ? 1.30 : null,
    latencyMs: null,
    cashOutSuccess: outcome === 'win' ? true : outcome === 'loss' ? false : null,
    failureReason: outcome === 'failed' ? 'timeout' : null,
  }));
}

function makeHitRate(observedRate: number, sampleSize: number): HitRateMetrics {
  return {
    observedRate,
    breakEvenRate: 1 / 1.30,
    confidenceInterval: {
      confidenceLevel: 0.95,
      lower: observedRate - 0.05,
      upper: observedRate + 0.05,
      margin: 0.05,
      sampleSize,
      isValid: sampleSize >= 10,
      center: observedRate,
      zScore: 1.96,
    },
    sampleSize,
    isAboveBreakEven: observedRate > 1 / 1.30,
    breakEvenWithinCI: true,
    statisticalSignificance: 'inconclusive',
  };
}

function makeDrawdown(maxDD: number, severity: DrawdownMetrics['drawdownSeverity'] = 'none'): DrawdownMetrics {
  return {
    maxDrawdown: maxDD,
    currentDrawdown: maxDD * 0.8,
    peakEquity: 10000,
    currentEquity: 10000 - maxDD * 0.8,
    underwaterDuration: 5,
    maxUnderwaterDuration: 10,
    recoveryCount: 2,
    isUnderwater: maxDD > 0,
    drawdownSeverity: severity,
  };
}

function makeStreaks(currentLoss: number, maxLoss: number): StreakMetrics {
  return {
    currentWinStreak: 0,
    currentLossStreak: currentLoss,
    maxWinStreak: 3,
    maxLossStreak: maxLoss,
    currentStreakType: currentLoss > 0 ? 'loss' : 'none',
    winStreakDistribution: [],
    lossStreakDistribution: [],
    expectedMaxWinStreak: 5,
    expectedMaxLossStreak: 5,
    streakAnomalyScore: currentLoss > 5 ? 2 : 0,
  };
}

function makeLatency(p95: number, sampleCount: number): LatencyMetrics {
  return {
    observationLatencyMs: p95 * 0.5,
    executionLatencyMs: p95 * 0.7,
    cashoutLatencyMs: p95 * 0.9,
    p50: p95 * 0.3,
    p95,
    p99: p95 * 1.2,
    max: p95 * 1.5,
    min: 10,
    sampleCount,
    degradationTrend: p95 > 1000 ? 'degrading' : 'stable',
  };
}

function makeCashOutSuccess(rate: number, attempts: number = 100): CashOutSuccessMetrics {
  return {
    successRate: rate,
    failureRate: 1 - rate,
    totalAttempts: attempts,
    successfulCashouts: Math.round(attempts * rate),
    failedCashouts: Math.round(attempts * (1 - rate)),
    timeoutCount: Math.round(attempts * (1 - rate) * 0.5),
    prematureCrashCount: 0,
    errorCount: Math.round(attempts * (1 - rate) * 0.5),
    trendDirection: rate >= 0.95 ? 'stable' : 'worsening',
    failureModeBreakdown: rate < 0.95 ? { timeout: 1, error: 1 } : {},
  };
}

function makeInput(overrides: Partial<AnomalyInput> = {}): AnomalyInput {
  return {
    outcomes: makeOutcomes(Array(80).fill('win').concat(Array(20).fill('loss'))),
    hitRate: makeHitRate(0.80, 100),
    drawdown: makeDrawdown(0),
    streaks: makeStreaks(0, 3),
    latency: makeLatency(300, 100),
    cashOutSuccess: makeCashOutSuccess(0.98),
    window: 'last_100',
    ...overrides,
  };
}

describe('detectAnomalies', () => {
  beforeEach(() => {
    clearAnomalyCooldowns();
  });

  it('returns empty array when all metrics are normal', () => {
    const input = makeInput();
    const flags = detectAnomalies(input);
    expect(flags.length).toBe(0);
  });

  it('flags hit_rate_drop when hit rate is significantly below break-even', () => {
    const input = makeInput({
      outcomes: makeOutcomes(Array(50).fill('loss').concat(Array(10).fill('win'))),
      hitRate: makeHitRate(0.60, 100),
    });
    const flags = detectAnomalies(input);

    const hitRateFlag = flags.find((f) => f.category === 'hit_rate_drop');
    expect(hitRateFlag).toBeDefined();
    expect(hitRateFlag!.severity).toBe('critical');
  });

  it('flags cashout_failure_spike when failure rate is high', () => {
    const input = makeInput({
      cashOutSuccess: makeCashOutSuccess(0.80, 100),
    });
    const flags = detectAnomalies(input);

    const cashoutFlag = flags.find((f) => f.category === 'cashout_failure_spike');
    expect(cashoutFlag).toBeDefined();
    expect(cashoutFlag!.severity).toBe('critical');
  });

  it('flags latency_spike when P95 is very high', () => {
    const input = makeInput({
      latency: makeLatency(5000, 100),
    });
    const flags = detectAnomalies(input);

    const latencyFlag = flags.find((f) => f.category === 'latency_spike');
    expect(latencyFlag).toBeDefined();
    expect(latencyFlag!.severity).toBe('critical');
  });

  it('flags balance_mismatch when difference exceeds tolerance', () => {
    const input = makeInput({
      balanceMismatch: {
        observed: 8000,
        expected: 10000,
        difference: 2000,
      },
    });
    const flags = detectAnomalies(input);

    const balanceFlag = flags.find((f) => f.category === 'balance_mismatch');
    expect(balanceFlag).toBeDefined();
  });

  it('flags losing_streak when streak is anomalous', () => {
    const input = makeInput({
      outcomes: makeOutcomes(Array(10).fill('loss').concat(Array(90).fill('win'))),
      streaks: makeStreaks(10, 10),
    });
    const flags = detectAnomalies(input);

    const streakFlag = flags.find((f) => f.category === 'losing_streak');
    expect(streakFlag).toBeDefined();
  });

  it('flags failed_entry_spike when failure rate is high', () => {
    const input = makeInput({
      outcomes: makeOutcomes(
        Array(20).fill('failed').concat(Array(80).fill('win'))
      ),
    });
    const flags = detectAnomalies(input);

    const failedFlag = flags.find((f) => f.category === 'failed_entry_spike');
    expect(failedFlag).toBeDefined();
  });

  it('flags observation_degradation when confidence is low', () => {
    const input = makeInput({
      observationConfidence: 'low',
    });
    const flags = detectAnomalies(input);

    const obsFlag = flags.find((f) => f.category === 'observation_degradation');
    expect(obsFlag).toBeDefined();
    expect(obsFlag!.severity).toBe('critical');
  });

  it('flags reconnect_loop when reconnect count is high', () => {
    const input = makeInput({
      reconnectCount: 5,
    });
    const flags = detectAnomalies(input);

    const reconnectFlag = flags.find((f) => f.category === 'reconnect_loop');
    expect(reconnectFlag).toBeDefined();
  });

  it('flags unknown_outcome_spike when unknown rate is high', () => {
    const input = makeInput({
      outcomes: makeOutcomes(
        Array(15).fill('unknown').concat(Array(85).fill('win'))
      ),
    });
    const flags = detectAnomalies(input);

    const unknownFlag = flags.find((f) => f.category === 'unknown_outcome_spike');
    expect(unknownFlag).toBeDefined();
  });

  it('flags drawdown_spike when drawdown is severe', () => {
    const input = makeInput({
      outcomes: makeOutcomes(
        Array(20).fill('loss').concat(Array(80).fill('win'))
      ),
      drawdown: makeDrawdown(10000, 'critical'),
    });
    const flags = detectAnomalies(input);

    const ddFlag = flags.find((f) => f.category === 'drawdown_spike');
    expect(ddFlag).toBeDefined();
  });

  it('returns no anomalies when disabled', () => {
    const input = makeInput({
      cashOutSuccess: makeCashOutSuccess(0.80, 100),
    });
    const flags = detectAnomalies(input, { enabled: false, categories: {} });
    expect(flags.length).toBe(0);
  });

  it('includes recommended action in each flag', () => {
    const input = makeInput({
      cashOutSuccess: makeCashOutSuccess(0.80, 100),
    });
    const flags = detectAnomalies(input);

    for (const flag of flags) {
      expect(flag.recommendedAction).toBeTruthy();
      expect(flag.recommendedAction.length).toBeGreaterThan(0);
    }
  });

  it('assigns unique IDs to each flag', () => {
    const input = makeInput({
      cashOutSuccess: makeCashOutSuccess(0.80, 100),
      latency: makeLatency(5000, 100),
    });
    const flags = detectAnomalies(input);

    const ids = flags.map((f) => f.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

describe('formatAnomalyFlags', () => {
  beforeEach(() => {
    clearAnomalyCooldowns();
  });

  it('produces a non-empty formatted string', () => {
    const input = makeInput({
      cashOutSuccess: makeCashOutSuccess(0.80, 100),
    });
    const flags = detectAnomalies(input);
    const formatted = formatAnomalyFlags(flags);

    expect(formatted).toContain('cashout_failure_spike');
    expect(formatted).toContain('Action:');
  });

  it('handles empty flags', () => {
    const formatted = formatAnomalyFlags([]);
    expect(formatted).toContain('No anomalies');
  });
});
