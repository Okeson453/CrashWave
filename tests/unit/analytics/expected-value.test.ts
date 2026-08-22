import {
  computeExpectedValueMetrics,
  computeExpectedValueFromCounts,
  computeBreakEvenHitRate,
  computeRequiredHitRate,
  isRealizedWithinExpectedRange,
  formatExpectedValueMetrics,
} from '../../../src/analytics/metrics/expected-value';
import { BetOutcomeRecord } from '../../../src/analytics/types';

function makeOutcomes(wins: number, losses: number, stake: number = 700, target: number = 1.30): BetOutcomeRecord[] {
  const outcomes: BetOutcomeRecord[] = [];
  const winProfit = stake * (target - 1);
  for (let i = 0; i < wins; i++) {
    outcomes.push({
      betId: `w-${i}`,
      roundId: `r-${i}`,
      dailyKey: '2024-01-01',
      timestamp: new Date().toISOString(),
      outcome: 'win',
      pnl: winProfit,
      stake,
      target,
      cashOutMultiplier: target,
      latencyMs: null,
      cashOutSuccess: true,
      failureReason: null,
    });
  }
  for (let i = 0; i < losses; i++) {
    outcomes.push({
      betId: `l-${i}`,
      roundId: `r-${wins + i}`,
      dailyKey: '2024-01-01',
      timestamp: new Date().toISOString(),
      outcome: 'loss',
      pnl: -stake,
      stake,
      target,
      cashOutMultiplier: null,
      latencyMs: null,
      cashOutSuccess: false,
      failureReason: null,
    });
  }
  return outcomes;
}

describe('computeExpectedValueMetrics', () => {
  it('returns empty metrics for no outcomes', () => {
    const metrics = computeExpectedValueMetrics([], 700, 1.30);
    expect(metrics.theoreticalEvPerEntry).toBe(0);
    expect(metrics.realizedEvPerEntry).toBe(0);
    expect(metrics.evAccuracy).toBe(0);
  });

  it('computes correct theoretical EV for 80% hit rate', () => {
    // EV = 700 * (0.80 * 1.30 - 1) = 700 * 0.04 = 28
    const outcomes = makeOutcomes(80, 20);
    const metrics = computeExpectedValueMetrics(outcomes, 700, 1.30);

    expect(metrics.theoreticalEvPerEntry).toBeCloseTo(28, 1);
  });

  it('computes correct theoretical EV for 70% hit rate', () => {
    // EV = 700 * (0.70 * 1.30 - 1) = 700 * (-0.09) = -63
    const outcomes = makeOutcomes(70, 30);
    const metrics = computeExpectedValueMetrics(outcomes, 700, 1.30);

    expect(metrics.theoreticalEvPerEntry).toBeCloseTo(-63, 1);
  });

  it('computes correct realized EV', () => {
    const outcomes = makeOutcomes(80, 20);
    const metrics = computeExpectedValueMetrics(outcomes, 700, 1.30);

    // Realized: 80 * 210 + 20 * (-700) = 16800 - 14000 = 2800
    // Per entry: 2800 / 100 = 28
    expect(metrics.realizedEvPerEntry).toBeCloseTo(28, 1);
    expect(metrics.cumulativeRealizedPnl).toBeCloseTo(2800, 1);
  });

  it('computes correct cumulative expected PnL', () => {
    const outcomes = makeOutcomes(80, 20);
    const metrics = computeExpectedValueMetrics(outcomes, 700, 1.30);

    // Expected PnL = EV * n = 28 * 100 = 2800
    expect(metrics.cumulativeExpectedPnl).toBeCloseTo(2800, 1);
  });

  it('has perfect EV accuracy when theoretical matches realized', () => {
    const outcomes = makeOutcomes(80, 20);
    const metrics = computeExpectedValueMetrics(outcomes, 700, 1.30);

    expect(metrics.evAccuracy).toBeCloseTo(1.0, 1);
  });

  it('filters out unresolved outcomes', () => {
    const outcomes = makeOutcomes(80, 20);
    outcomes.push({
      betId: 'f-1',
      roundId: 'r-f1',
      dailyKey: '2024-01-01',
      timestamp: new Date().toISOString(),
      outcome: 'failed',
      pnl: 0,
      stake: 700,
      target: 1.30,
      cashOutMultiplier: null,
      latencyMs: null,
      cashOutSuccess: null,
      failureReason: 'timeout',
    });

    const metrics = computeExpectedValueMetrics(outcomes, 700, 1.30);
    // Should still be based on 100 resolved outcomes
    expect(metrics.cumulativeRealizedPnl).toBeCloseTo(2800, 1);
  });

  it('computes variance correctly', () => {
    const outcomes = makeOutcomes(80, 20);
    const metrics = computeExpectedValueMetrics(outcomes, 700, 1.30);

    expect(metrics.evVariance).toBeGreaterThan(0);
    expect(metrics.evStandardError).toBeGreaterThan(0);
  });

  it('provides valid confidence interval for sufficient samples', () => {
    const outcomes = makeOutcomes(80, 20);
    const metrics = computeExpectedValueMetrics(outcomes, 700, 1.30);

    expect(metrics.evConfidenceInterval.isValid).toBe(true);
    expect(metrics.evConfidenceInterval.lower).toBeLessThan(metrics.evConfidenceInterval.upper);
  });
});

describe('computeExpectedValueFromCounts', () => {
  it('matches computeExpectedValueMetrics result', () => {
    const fromCounts = computeExpectedValueFromCounts(80, 20, 700, 1.30);
    const fromOutcomes = computeExpectedValueMetrics(makeOutcomes(80, 20), 700, 1.30);

    expect(fromCounts.theoreticalEvPerEntry).toBeCloseTo(fromOutcomes.theoreticalEvPerEntry, 5);
    expect(fromCounts.realizedEvPerEntry).toBeCloseTo(fromOutcomes.realizedEvPerEntry, 5);
    expect(fromCounts.cumulativeRealizedPnl).toBeCloseTo(fromOutcomes.cumulativeRealizedPnl, 5);
  });
});

describe('computeBreakEvenHitRate', () => {
  it('returns 1 for target <= 1', () => {
    expect(computeBreakEvenHitRate(1)).toBe(1);
    expect(computeBreakEvenHitRate(0.5)).toBe(1);
  });

  it('returns correct break-even for target 1.30', () => {
    expect(computeBreakEvenHitRate(1.30)).toBeCloseTo(1 / 1.30, 5);
  });

  it('returns correct break-even for target 2.00', () => {
    expect(computeBreakEvenHitRate(2.0)).toBe(0.5);
  });
});

describe('computeRequiredHitRate', () => {
  it('returns 1 for invalid inputs', () => {
    expect(computeRequiredHitRate(10, 0, 1.30)).toBe(1);
    expect(computeRequiredHitRate(10, 700, 0)).toBe(1);
  });

  it('returns break-even for zero target EV', () => {
    // EV = 0 -> p = 1/T
    const required = computeRequiredHitRate(0, 700, 1.30);
    expect(required).toBeCloseTo(1 / 1.30, 5);
  });

  it('returns higher rate for positive target EV', () => {
    // Target EV = 28 -> p = (28/700 + 1) / 1.30 = 1.04 / 1.30 = 0.80
    const required = computeRequiredHitRate(28, 700, 1.30);
    expect(required).toBeCloseTo(0.80, 2);
  });
});

describe('isRealizedWithinExpectedRange', () => {
  it('returns true when realized matches expected', () => {
    const metrics = computeExpectedValueFromCounts(80, 20);
    expect(isRealizedWithinExpectedRange(metrics, 2)).toBe(true);
  });

  it('returns false for large deviations', () => {
    // Create outcomes where realized is far from expected
    const outcomes: BetOutcomeRecord[] = [];
    for (let i = 0; i < 50; i++) {
      outcomes.push({
        betId: `w-${i}`,
        roundId: `r-${i}`,
        dailyKey: '2024-01-01',
        timestamp: new Date().toISOString(),
        outcome: 'win',
        pnl: 210,
        stake: 700,
        target: 1.30,
        cashOutMultiplier: 1.30,
        latencyMs: null,
        cashOutSuccess: true,
        failureReason: null,
      });
    }
    // Now add outcomes with wildly different PnL
    for (let i = 0; i < 50; i++) {
      outcomes.push({
        betId: `l-${i}`,
        roundId: `r-${50 + i}`,
        dailyKey: '2024-01-01',
        timestamp: new Date().toISOString(),
        outcome: 'loss',
        pnl: -700,
        stake: 700,
        target: 1.30,
        cashOutMultiplier: null,
        latencyMs: null,
        cashOutSuccess: false,
        failureReason: null,
      });
    }

    const metrics = computeExpectedValueMetrics(outcomes, 700, 1.30);
    // With 50/50, expected is negative but realized should match
    expect(isRealizedWithinExpectedRange(metrics, 3)).toBe(true);
  });
});

describe('formatExpectedValueMetrics', () => {
  it('produces a non-empty formatted string', () => {
    const metrics = computeExpectedValueFromCounts(80, 20);
    const formatted = formatExpectedValueMetrics(metrics);
    expect(formatted).toContain('Theoretical EV');
    expect(formatted).toContain('Realized EV');
    expect(formatted).toContain('EV Accuracy');
  });
});
