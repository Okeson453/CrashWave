import {
  computeStreakMetrics,
  streakProbability,
  isAnomalousLosingStreak,
  formatStreakMetrics,
} from '../../../src/analytics/metrics/streaks';
import { BetOutcomeRecord } from '../../../src/analytics/types';

function makeOutcomes(pattern: ('win' | 'loss' | 'failed')[]): BetOutcomeRecord[] {
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
    cashOutSuccess: outcome === 'win',
    failureReason: null,
  }));
}

describe('computeStreakMetrics', () => {
  it('returns empty metrics for no outcomes', () => {
    const metrics = computeStreakMetrics([], 0.5);
    expect(metrics.currentWinStreak).toBe(0);
    expect(metrics.currentLossStreak).toBe(0);
    expect(metrics.maxWinStreak).toBe(0);
    expect(metrics.maxLossStreak).toBe(0);
    expect(metrics.currentStreakType).toBe('none');
  });

  it('tracks current win streak', () => {
    const outcomes = makeOutcomes(['win', 'win', 'win', 'loss']);
    const metrics = computeStreakMetrics(outcomes, 0.5);

    expect(metrics.currentWinStreak).toBe(0); // last is loss
    expect(metrics.currentLossStreak).toBe(1);
    expect(metrics.maxWinStreak).toBe(3);
    expect(metrics.maxLossStreak).toBe(1);
  });

  it('tracks current loss streak', () => {
    const outcomes = makeOutcomes(['win', 'loss', 'loss', 'loss']);
    const metrics = computeStreakMetrics(outcomes, 0.5);

    expect(metrics.currentWinStreak).toBe(0);
    expect(metrics.currentLossStreak).toBe(3);
    expect(metrics.maxWinStreak).toBe(1);
    expect(metrics.maxLossStreak).toBe(3);
  });

  it('ignores failed outcomes', () => {
    const outcomes = makeOutcomes(['win', 'win', 'failed', 'loss', 'loss']);
    const metrics = computeStreakMetrics(outcomes, 0.5);

    // failed breaks the streak
    expect(metrics.maxWinStreak).toBe(2);
    expect(metrics.maxLossStreak).toBe(2);
  });

  it('computes streak distributions', () => {
    const outcomes = makeOutcomes([
      'win', 'win', 'loss', 'loss', 'loss', 'win', 'win', 'win', 'win',
    ]);
    const metrics = computeStreakMetrics(outcomes, 0.5);

    expect(metrics.winStreakDistribution.length).toBeGreaterThan(0);
    expect(metrics.lossStreakDistribution.length).toBeGreaterThan(0);

    // Should have a streak of length 4 in distribution
    const streakOf4 = metrics.winStreakDistribution.find((d) => d.length === 4);
    expect(streakOf4).toBeDefined();
    expect(streakOf4!.count).toBe(1);
  });

  it('computes expected max streaks', () => {
    const outcomes = makeOutcomes(Array(100).fill('win'));
    const metrics = computeStreakMetrics(outcomes, 0.5);

    expect(metrics.expectedMaxWinStreak).toBeGreaterThan(0);
    expect(metrics.expectedMaxLossStreak).toBeGreaterThan(0);
  });

  it('computes anomaly score for normal streaks', () => {
    const outcomes = makeOutcomes(['win', 'loss', 'win', 'loss', 'win', 'loss']);
    const metrics = computeStreakMetrics(outcomes, 0.5);

    expect(metrics.streakAnomalyScore).toBeLessThan(1);
  });

  it('computes higher anomaly score for extreme streaks', () => {
    const normal = makeOutcomes(['win', 'loss', 'win', 'loss', 'win', 'loss']);
    const extreme = makeOutcomes(Array(20).fill('loss'));

    const normalMetrics = computeStreakMetrics(normal, 0.5);
    const extremeMetrics = computeStreakMetrics(extreme, 0.5);

    expect(extremeMetrics.streakAnomalyScore).toBeGreaterThan(normalMetrics.streakAnomalyScore);
  });
});

describe('streakProbability', () => {
  it('returns 0 when n < k', () => {
    expect(streakProbability(5, 0.5, 10)).toBe(0);
  });

  it('returns 1 when p = 1', () => {
    expect(streakProbability(10, 1, 5)).toBe(1);
  });

  it('returns reasonable probability for coin flips', () => {
    // Probability of at least 5 heads in a row in 100 flips
    const prob = streakProbability(100, 0.5, 5);
    expect(prob).toBeGreaterThan(0.5);
    expect(prob).toBeLessThan(1);
  });

  it('increases with larger n', () => {
    const p100 = streakProbability(100, 0.5, 5);
    const p1000 = streakProbability(1000, 0.5, 5);
    expect(p1000).toBeGreaterThan(p100);
  });
});

describe('isAnomalousLosingStreak', () => {
  it('returns false for short streaks', () => {
    expect(isAnomalousLosingStreak(2, 10, 50)).toBe(false);
  });

  it('returns false for small sample', () => {
    expect(isAnomalousLosingStreak(5, 5, 10)).toBe(false);
  });

  it('returns true for very long losing streak', () => {
    // 15 losses in a row out of 100 total with 50% loss rate
    expect(isAnomalousLosingStreak(15, 50, 100)).toBe(true);
  });

  it('returns false for moderate streak', () => {
    // 5 losses in a row out of 100 with 50% loss rate
    expect(isAnomalousLosingStreak(5, 50, 100)).toBe(false);
  });
});

describe('formatStreakMetrics', () => {
  it('produces a non-empty formatted string', () => {
    const outcomes = makeOutcomes(['win', 'win', 'loss', 'loss', 'loss']);
    const metrics = computeStreakMetrics(outcomes, 0.5);
    const formatted = formatStreakMetrics(metrics);
    expect(formatted).toContain('Current Streak');
    expect(formatted).toContain('Max Win Streak');
    expect(formatted).toContain('Max Loss Streak');
  });
});
