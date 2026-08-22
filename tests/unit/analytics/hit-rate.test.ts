import {
  wilsonScoreInterval,
  computeHitRateMetrics,
  computeHitRateFromCounts,
  isSignificantlyProfitable,
  isSignificantlyUnprofitable,
  formatHitRateMetrics,
} from '../../../src/analytics/metrics/hit-rate';
import { BetOutcomeRecord } from '../../../src/analytics/types';

function makeOutcomes(wins: number, losses: number, target: number = 1.30): BetOutcomeRecord[] {
  const outcomes: BetOutcomeRecord[] = [];
  const winProfit = 700 * (target - 1);
  for (let i = 0; i < wins; i++) {
    outcomes.push({
      betId: `w-${i}`,
      roundId: `r-${i}`,
      dailyKey: '2024-01-01',
      timestamp: new Date().toISOString(),
      outcome: 'win',
      pnl: winProfit,
      stake: 700,
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
      pnl: -700,
      stake: 700,
      target,
      cashOutMultiplier: null,
      latencyMs: null,
      cashOutSuccess: false,
      failureReason: null,
    });
  }
  return outcomes;
}

describe('wilsonScoreInterval', () => {
  it('returns [0,1] for zero trials', () => {
    const ci = wilsonScoreInterval(0, 0);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBe(1);
    expect(ci.isValid).toBe(false);
  });

  it('returns valid interval for 50% hit rate with 100 trials', () => {
    const ci = wilsonScoreInterval(50, 100);
    expect(ci.isValid).toBe(true);
    expect(ci.lower).toBeGreaterThan(0.3);
    expect(ci.upper).toBeLessThan(0.7);
    expect(ci.center).toBeCloseTo(0.5, 1);
  });

  it('returns valid interval for 80% hit rate with 100 trials', () => {
    const ci = wilsonScoreInterval(80, 100);
    expect(ci.isValid).toBe(true);
    expect(ci.lower).toBeGreaterThan(0.70);
    expect(ci.upper).toBeLessThan(0.90);
    expect(ci.center).toBeCloseTo(0.8, 1);
  });

  it('handles all successes', () => {
    const ci = wilsonScoreInterval(100, 100);
    expect(ci.isValid).toBe(true);
    expect(ci.lower).toBeGreaterThan(0.95);
    expect(ci.upper).toBe(1);
  });

  it('handles all failures', () => {
    const ci = wilsonScoreInterval(0, 100);
    expect(ci.isValid).toBe(true);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeLessThan(0.05);
  });

  it('narrows as sample size increases', () => {
    const ci10 = wilsonScoreInterval(5, 10);
    const ci100 = wilsonScoreInterval(50, 100);
    const ci1000 = wilsonScoreInterval(500, 1000);

    const width10 = ci10.upper - ci10.lower;
    const width100 = ci100.upper - ci100.lower;
    const width1000 = ci1000.upper - ci1000.lower;

    expect(width100).toBeLessThan(width10);
    expect(width1000).toBeLessThan(width100);
  });

  it('uses correct z-score for 95% confidence', () => {
    const ci = wilsonScoreInterval(50, 100, 0.95);
    expect(ci.zScore).toBeCloseTo(1.96, 1);
  });

  it('uses correct z-score for 99% confidence', () => {
    const ci = wilsonScoreInterval(50, 100, 0.99);
    expect(ci.zScore).toBeCloseTo(2.576, 1);
  });
});

describe('computeHitRateMetrics', () => {
  it('computes correct hit rate for 80 wins / 20 losses', () => {
    const outcomes = makeOutcomes(80, 20);
    const metrics = computeHitRateMetrics(outcomes);

    expect(metrics.observedRate).toBe(0.8);
    expect(metrics.breakEvenRate).toBeCloseTo(1 / 1.30, 5);
    expect(metrics.sampleSize).toBe(100);
    expect(metrics.isAboveBreakEven).toBe(true);
  });

  it('identifies hit rate below break-even', () => {
    const outcomes = makeOutcomes(70, 30);
    const metrics = computeHitRateMetrics(outcomes);

    expect(metrics.observedRate).toBe(0.7);
    expect(metrics.isAboveBreakEven).toBe(false);
  });

  it('filters out failed and unknown outcomes', () => {
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

    const metrics = computeHitRateMetrics(outcomes);
    expect(metrics.sampleSize).toBe(100); // failed excluded
  });

  it('marks insufficient data for small samples', () => {
    const outcomes = makeOutcomes(3, 2);
    const metrics = computeHitRateMetrics(outcomes);

    expect(metrics.statisticalSignificance).toBe('insufficient_data');
  });

  it('marks significant_above when CI is entirely above break-even', () => {
    // 90 wins out of 100 with target 1.30 -> break-even ~76.9%
    // Wilson CI should be entirely above 76.9%
    const outcomes = makeOutcomes(90, 10);
    const metrics = computeHitRateMetrics(outcomes);

    expect(metrics.statisticalSignificance).toBe('significant_above');
    expect(metrics.breakEvenWithinCI).toBe(false);
  });

  it('marks significant_below when CI is entirely below break-even', () => {
    // 60 wins out of 100 with target 1.30 -> break-even ~76.9%
    const outcomes = makeOutcomes(60, 40);
    const metrics = computeHitRateMetrics(outcomes);

    expect(metrics.statisticalSignificance).toBe('significant_below');
  });

  it('marks inconclusive when break-even is within CI', () => {
    // 78 wins out of 100 -> observed 78%, BE ~76.9%
    // CI should contain BE
    const outcomes = makeOutcomes(78, 22);
    const metrics = computeHitRateMetrics(outcomes);

    expect(metrics.statisticalSignificance).toBe('inconclusive');
    expect(metrics.breakEvenWithinCI).toBe(true);
  });
});

describe('computeHitRateFromCounts', () => {
  it('produces same result as computeHitRateMetrics', () => {
    const fromCounts = computeHitRateFromCounts(80, 20);
    const fromOutcomes = computeHitRateMetrics(makeOutcomes(80, 20));

    expect(fromCounts.observedRate).toBe(fromOutcomes.observedRate);
    expect(fromCounts.breakEvenRate).toBe(fromOutcomes.breakEvenRate);
    expect(fromCounts.sampleSize).toBe(fromOutcomes.sampleSize);
  });
});

describe('isSignificantlyProfitable', () => {
  it('returns true when lower CI exceeds break-even', () => {
    const metrics = computeHitRateFromCounts(90, 10);
    expect(isSignificantlyProfitable(metrics)).toBe(true);
  });

  it('returns false for small samples even if rate looks good', () => {
    const metrics = computeHitRateFromCounts(9, 1);
    expect(isSignificantlyProfitable(metrics)).toBe(false);
  });

  it('returns false when CI contains break-even', () => {
    const metrics = computeHitRateFromCounts(78, 22);
    expect(isSignificantlyProfitable(metrics)).toBe(false);
  });
});

describe('isSignificantlyUnprofitable', () => {
  it('returns true when upper CI is below break-even', () => {
    const metrics = computeHitRateFromCounts(60, 40);
    expect(isSignificantlyUnprofitable(metrics)).toBe(true);
  });

  it('returns false for profitable metrics', () => {
    const metrics = computeHitRateFromCounts(90, 10);
    expect(isSignificantlyUnprofitable(metrics)).toBe(false);
  });
});

describe('formatHitRateMetrics', () => {
  it('produces a non-empty string', () => {
    const metrics = computeHitRateFromCounts(80, 20);
    const formatted = formatHitRateMetrics(metrics);
    expect(formatted).toContain('80.00%');
    expect(formatted).toContain('Break-Even');
    expect(formatted).toContain('95% CI');
  });
});
