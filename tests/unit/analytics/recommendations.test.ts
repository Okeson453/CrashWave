import {
  generateRecommendations,
  getMostSevereRecommendation,
  hasRecommendationOfSeverityOrWorse,
  formatRecommendations,
} from '../../../src/analytics/learning/recommendations';
import { RecommendationInput } from '../../../src/analytics/learning/recommendations';
import { HitRateMetrics, DrawdownMetrics, StreakMetrics, CashOutSuccessMetrics, ExpectedValueMetrics } from '../../../src/analytics/types';

function makeHitRate(observedRate: number, sampleSize: number, breakEvenRate: number = 1 / 1.30): HitRateMetrics {
  const z = 1.96;
  const p = observedRate;
  const n = sampleSize;
  const denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / denominator;

  let significance: HitRateMetrics['statisticalSignificance'];
  if (n < 10) significance = 'insufficient_data';
  else if (center - margin > breakEvenRate) significance = 'significant_above';
  else if (center + margin < breakEvenRate) significance = 'significant_below';
  else significance = 'inconclusive';

  return {
    observedRate,
    breakEvenRate,
    confidenceInterval: {
      confidenceLevel: 0.95,
      lower: Math.max(0, center - margin),
      upper: Math.min(1, center + margin),
      margin,
      sampleSize: n,
      isValid: n >= 10,
      center,
      zScore: z,
    },
    sampleSize: n,
    isAboveBreakEven: observedRate > breakEvenRate,
    breakEvenWithinCI: significance === 'inconclusive',
    statisticalSignificance: significance,
  };
}

function makeDrawdown(maxDD: number, currentDD: number, severity: DrawdownMetrics['drawdownSeverity'] = 'none'): DrawdownMetrics {
  return {
    maxDrawdown: maxDD,
    currentDrawdown: currentDD,
    peakEquity: 10000,
    currentEquity: 10000 - currentDD,
    underwaterDuration: currentDD > 0 ? 5 : 0,
    maxUnderwaterDuration: 10,
    recoveryCount: 2,
    isUnderwater: currentDD > 0,
    drawdownSeverity: severity,
  };
}

function makeStreaks(currentLoss: number, maxLoss: number, anomalyScore: number = 0): StreakMetrics {
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
    streakAnomalyScore: anomalyScore,
  };
}

function makeCashOutSuccess(rate: number): CashOutSuccessMetrics {
  const attempts = 100;
  return {
    successRate: rate,
    failureRate: 1 - rate,
    totalAttempts: attempts,
    successfulCashouts: Math.round(attempts * rate),
    failedCashouts: Math.round(attempts * (1 - rate)),
    timeoutCount: 0,
    prematureCrashCount: 0,
    errorCount: 0,
    trendDirection: rate >= 0.95 ? 'stable' : 'worsening',
    failureModeBreakdown: {},
  };
}

function makeExpectedValue(realizedPnl: number, expectedPnl: number): ExpectedValueMetrics {
  return {
    theoreticalEvPerEntry: expectedPnl / 100,
    realizedEvPerEntry: realizedPnl / 100,
    cumulativeExpectedPnl: expectedPnl,
    cumulativeRealizedPnl: realizedPnl,
    evVariance: 10000,
    evStandardError: 100,
    evConfidenceInterval: {
      confidenceLevel: 0.95,
      lower: realizedPnl / 100 - 200,
      upper: realizedPnl / 100 + 200,
      margin: 200,
      sampleSize: 100,
      isValid: true,
    },
    evAccuracy: expectedPnl !== 0 ? realizedPnl / expectedPnl : 0,
  };
}

function makeInput(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    hitRate: makeHitRate(0.80, 100),
    drawdown: makeDrawdown(500, 200),
    streaks: makeStreaks(0, 3),
    cashOutSuccess: makeCashOutSuccess(0.98),
    expectedValue: makeExpectedValue(2800, 2800),
    window: 'last_100',
    ...overrides,
  };
}

describe('generateRecommendations', () => {
  it('recommends continue when all metrics are normal', () => {
    const input = makeInput();
    const recs = generateRecommendations(input);

    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0].type).toBe('continue');
  });

  it('recommends stop when cash-out success is critical', () => {
    const input = makeInput({
      cashOutSuccess: makeCashOutSuccess(0.80),
    });
    const recs = generateRecommendations(input);

    const stopRec = recs.find((r) => r.type === 'stop');
    expect(stopRec).toBeDefined();
    expect(stopRec!.priority).toBeLessThanOrEqual(2);
  });

  it('recommends pause when cash-out success is poor', () => {
    const input = makeInput({
      cashOutSuccess: makeCashOutSuccess(0.88),
    });
    const recs = generateRecommendations(input);

    const pauseRec = recs.find((r) => r.type === 'pause');
    expect(pauseRec).toBeDefined();
  });

  it('recommends dry_run when hit rate is significantly below break-even with negative P&L', () => {
    const input = makeInput({
      hitRate: makeHitRate(0.65, 100),
      expectedValue: makeExpectedValue(-2000, -2000),
    });
    const recs = generateRecommendations(input);

    const dryRunRec = recs.find((r) => r.type === 'dry_run');
    expect(dryRunRec).toBeDefined();
  });

  it('recommends pause when hit rate is below break-even but not statistically significant', () => {
    const input = makeInput({
      hitRate: makeHitRate(0.73, 100), // Below BE ~76.9% but not significant
      expectedValue: makeExpectedValue(-500, -500),
    });
    const recs = generateRecommendations(input);

    const pauseRec = recs.find((r) => r.type === 'pause');
    expect(pauseRec).toBeDefined();
  });

  it('recommends stop when drawdown exceeds threshold', () => {
    const input = makeInput({
      drawdown: makeDrawdown(20000, 18000, 'critical'),
    });
    const recs = generateRecommendations(input);

    const stopRec = recs.find((r) => r.type === 'stop');
    expect(stopRec).toBeDefined();
  });

  it('recommends stop when drawdown is severe (exceeds bankroll threshold)', () => {
    const input = makeInput({
      drawdown: makeDrawdown(5000, 4000, 'severe'),
    });
    const recs = generateRecommendations(input);

    const stopRec = recs.find((r) => r.type === 'stop');
    expect(stopRec).toBeDefined();
  });

  it('recommends dry_run for anomalous losing streak', () => {
    const input = makeInput({
      streaks: makeStreaks(8, 8, 2.0),
    });
    const recs = generateRecommendations(input);

    const dryRunRec = recs.find((r) => r.type === 'dry_run');
    expect(dryRunRec).toBeDefined();
  });

  it('recommends reduce_exposure when balance is low', () => {
    const input = makeInput({
      currentBalance: 5000, // Less than 10x stake (7000)
    });
    const recs = generateRecommendations(input);

    const reduceRec = recs.find((r) => r.type === 'reduce_exposure');
    expect(reduceRec).toBeDefined();
  });

  it('recommends review when observation confidence is low', () => {
    const input = makeInput({
      observationConfidence: 'low',
    });
    const recs = generateRecommendations(input);

    const reviewRec = recs.find((r) => r.type === 'review');
    expect(reviewRec).toBeDefined();
  });

  it('recommends pause on consecutive errors', () => {
    const input = makeInput({
      consecutiveErrors: 5,
    });
    const recs = generateRecommendations(input);

    const pauseRec = recs.find((r) => r.type === 'pause');
    expect(pauseRec).toBeDefined();
  });

  it('recommends review when EV accuracy is poor', () => {
    const input = makeInput({
      expectedValue: makeExpectedValue(500, 5000), // 10% accuracy
    });
    const recs = generateRecommendations(input);

    const reviewRec = recs.find((r) => r.type === 'review');
    expect(reviewRec).toBeDefined();
  });

  it('never recommends increasing stake or target', () => {
    const input = makeInput({
      hitRate: makeHitRate(0.90, 100),
      expectedValue: makeExpectedValue(5000, 5000),
    });
    const recs = generateRecommendations(input);

    for (const rec of recs) {
      expect(rec.message.toLowerCase()).not.toContain('increase stake');
      expect(rec.message.toLowerCase()).not.toContain('increase target');
      expect(rec.rationale.toLowerCase()).not.toContain('increase stake');
      expect(rec.rationale.toLowerCase()).not.toContain('increase target');
    }
  });

  it('limits recommendations to max per window', () => {
    const input = makeInput({
      cashOutSuccess: makeCashOutSuccess(0.80),
      drawdown: makeDrawdown(20000, 18000, 'critical'),
      observationConfidence: 'low',
    });
    const recs = generateRecommendations(input);

    expect(recs.length).toBeLessThanOrEqual(3);
  });

  it('sorts recommendations by priority', () => {
    const input = makeInput({
      cashOutSuccess: makeCashOutSuccess(0.80),
      drawdown: makeDrawdown(20000, 18000, 'critical'),
    });
    const recs = generateRecommendations(input);

    for (let i = 1; i < recs.length; i++) {
      expect(recs[i].priority).toBeGreaterThanOrEqual(recs[i - 1].priority);
    }
  });
});

describe('getMostSevereRecommendation', () => {
  it('returns stop over pause', () => {
    const input = makeInput({
      cashOutSuccess: makeCashOutSuccess(0.80),
      drawdown: makeDrawdown(20000, 18000, 'critical'),
    });
    const recs = generateRecommendations(input);
    const mostSevere = getMostSevereRecommendation(recs);

    expect(mostSevere).toBeDefined();
    expect(mostSevere!.type).toBe('stop');
  });

  it('returns null for empty array', () => {
    expect(getMostSevereRecommendation([])).toBeNull();
  });
});

describe('hasRecommendationOfSeverityOrWorse', () => {
  it('returns true when stop is present', () => {
    const input = makeInput({
      cashOutSuccess: makeCashOutSuccess(0.80),
    });
    const recs = generateRecommendations(input);

    expect(hasRecommendationOfSeverityOrWorse(recs, 'stop')).toBe(true);
    expect(hasRecommendationOfSeverityOrWorse(recs, 'pause')).toBe(true);
  });

  it('returns false when only continue is present', () => {
    const input = makeInput();
    const recs = generateRecommendations(input);

    expect(hasRecommendationOfSeverityOrWorse(recs, 'pause')).toBe(false);
  });
});

describe('formatRecommendations', () => {
  it('produces a non-empty formatted string', () => {
    const input = makeInput();
    const recs = generateRecommendations(input);
    const formatted = formatRecommendations(recs);

    expect(formatted).toContain('CONTINUE');
    expect(formatted).toContain('Rationale');
  });

  it('handles empty recommendations', () => {
    const formatted = formatRecommendations([]);
    expect(formatted).toContain('No recommendations');
  });
});
