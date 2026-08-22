/**
 * Streak Metrics — Win/Loss Streak Distribution Analysis
 *
 * Computes current streak, maximum streaks, streak distributions,
 * expected maximum streaks, and streak anomaly scores.
 *
 * A streak is a consecutive sequence of the same outcome (win or loss).
 * Failed and unknown bets break streaks (they are neither wins nor losses).
 */

import { StreakMetrics, StreakDistribution, BetOutcomeRecord } from '../types';
import { STREAK_MAX_TRACKED_LENGTH } from '../constants';

/**
 * Compute streak metrics from an array of bet outcomes.
 *
 * @param outcomes — array of bet outcome records
 * @param hitRate — observed hit rate (for expected streak calculations)
 * @returns StreakMetrics with full streak analysis
 */
export function computeStreakMetrics(
  outcomes: BetOutcomeRecord[],
  hitRate: number = 0.5
): StreakMetrics {
  // Filter to resolved outcomes only
  const resolved = outcomes.filter(
    (o) => o.outcome === 'win' || o.outcome === 'loss'
  );

  if (resolved.length === 0) {
    return emptyStreakMetrics();
  }

  let currentWinStreak = 0;
  let currentLossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;

  const winStreakCounts = new Map<number, number>();
  const lossStreakCounts = new Map<number, number>();

  let currentStreakType: 'win' | 'loss' | 'none' = 'none';
  let currentStreakLength = 0;

  for (const outcome of resolved) {
    if (outcome.outcome === 'win') {
      if (currentStreakType === 'win') {
        currentStreakLength++;
      } else {
        // Streak ended, record previous if it was a loss streak
        if (currentStreakType === 'loss' && currentStreakLength > 0) {
          lossStreakCounts.set(
            currentStreakLength,
            (lossStreakCounts.get(currentStreakLength) || 0) + 1
          );
        }
        currentStreakType = 'win';
        currentStreakLength = 1;
      }
      currentWinStreak = currentStreakLength;
      currentLossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
    } else {
      // loss
      if (currentStreakType === 'loss') {
        currentStreakLength++;
      } else {
        // Streak ended, record previous if it was a win streak
        if (currentStreakType === 'win' && currentStreakLength > 0) {
          winStreakCounts.set(
            currentStreakLength,
            (winStreakCounts.get(currentStreakLength) || 0) + 1
          );
        }
        currentStreakType = 'loss';
        currentStreakLength = 1;
      }
      currentLossStreak = currentStreakLength;
      currentWinStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
    }
  }

  // Record the final streak
  if (currentStreakType === 'win' && currentStreakLength > 0) {
    winStreakCounts.set(
      currentStreakLength,
      (winStreakCounts.get(currentStreakLength) || 0) + 1
    );
  } else if (currentStreakType === 'loss' && currentStreakLength > 0) {
    lossStreakCounts.set(
      currentStreakLength,
      (lossStreakCounts.get(currentStreakLength) || 0) + 1
    );
  }

  const totalWinStreaks = Array.from(winStreakCounts.values()).reduce((a, b) => a + b, 0);
  const totalLossStreaks = Array.from(lossStreakCounts.values()).reduce((a, b) => a + b, 0);

  const winStreakDistribution = buildDistribution(winStreakCounts, totalWinStreaks);
  const lossStreakDistribution = buildDistribution(lossStreakCounts, totalLossStreaks);

  const n = resolved.length;
  const p = hitRate;
  const expectedMaxWinStreak = expectedMaxStreak(n, p);
  const expectedMaxLossStreak = expectedMaxStreak(n, 1 - p);

  const streakAnomalyScore = computeStreakAnomalyScore(
    maxWinStreak,
    maxLossStreak,
    expectedMaxWinStreak,
    expectedMaxLossStreak
  );

  return {
    currentWinStreak,
    currentLossStreak,
    maxWinStreak,
    maxLossStreak,
    currentStreakType:
      currentWinStreak > 0 ? 'win' : currentLossStreak > 0 ? 'loss' : 'none',
    winStreakDistribution,
    lossStreakDistribution,
    expectedMaxWinStreak,
    expectedMaxLossStreak,
    streakAnomalyScore,
  };
}

/**
 * Build a streak distribution from raw counts.
 */
function buildDistribution(
  counts: Map<number, number>,
  total: number
): StreakDistribution[] {
  const distribution: StreakDistribution[] = [];

  const maxLength = Math.max(...Array.from(counts.keys()), 0);
  const limit = Math.min(maxLength, STREAK_MAX_TRACKED_LENGTH);

  for (let length = 1; length <= limit; length++) {
    const count = counts.get(length) || 0;
    distribution.push({
      length,
      count,
      frequency: total > 0 ? count / total : 0,
    });
  }

  return distribution;
}

/**
 * Compute the expected maximum streak length for n trials with probability p.
 *
 * Uses the approximation: E[max streak] ≈ log_{1/p}(n * (1-p)) + gamma / ln(1/p)
 * where gamma is the Euler-Mascheroni constant.
 *
 * For small n, this is clamped to reasonable bounds.
 */
function expectedMaxStreak(n: number, p: number): number {
  if (n <= 0 || p <= 0 || p >= 1) return 1;

  const eulerMascheroni = 0.5772156649015329;
  const logDenom = Math.log(1 / p);

  // Approximation from Feller's work on runs
  const expected = Math.log(n * (1 - p)) / logDenom + eulerMascheroni / logDenom - 0.5;

  return Math.max(1, expected);
}

/**
 * Compute a streak anomaly score based on how much observed max streaks
 * deviate from expected max streaks.
 *
 * Score ranges from 0 (normal) to 1+ (highly anomalous).
 */
function computeStreakAnomalyScore(
  maxWinStreak: number,
  maxLossStreak: number,
  expectedMaxWin: number,
  expectedMaxLoss: number
): number {
  const winDeviation = expectedMaxWin > 0 ? maxWinStreak / expectedMaxWin : 1;
  const lossDeviation = expectedMaxLoss > 0 ? maxLossStreak / expectedMaxLoss : 1;

  // Use the maximum deviation as the anomaly score
  // A score > 2.0 indicates a potentially anomalous streak
  const score = Math.max(winDeviation, lossDeviation);

  return Math.max(0, score - 1); // Normalize: 0 = normal, >1 = anomalous
}

/**
 * Compute the probability of observing a streak of at least length k
 * in n trials with probability p.
 *
 * Uses the approximation: P(max streak >= k) ≈ 1 - (1 - p^k)^{n-k+1}
 */
export function streakProbability(n: number, p: number, k: number): number {
  if (n < k || k <= 0 || p <= 0 || p > 1) return 0;
  if (p === 1) return 1;

  const probNoStreak = Math.pow(1 - Math.pow(p, k), n - k + 1);
  return 1 - probNoStreak;
}

/**
 * Check if a current losing streak is statistically anomalous.
 *
 * @param currentLossStreak — current consecutive losses
 * @param totalLosses — total losses observed
 * @param totalTrials — total resolved trials
 * @returns true if the streak is unusually long
 */
export function isAnomalousLosingStreak(
  currentLossStreak: number,
  totalLosses: number,
  totalTrials: number
): boolean {
  if (totalTrials < 20 || currentLossStreak < 3) return false;

  const lossRate = totalLosses / totalTrials;
  const prob = streakProbability(totalTrials, lossRate, currentLossStreak);

  // If probability < 5%, consider it anomalous
  return prob < 0.05;
}

/**
 * Return an empty streak metrics object.
 */
function emptyStreakMetrics(): StreakMetrics {
  return {
    currentWinStreak: 0,
    currentLossStreak: 0,
    maxWinStreak: 0,
    maxLossStreak: 0,
    currentStreakType: 'none',
    winStreakDistribution: [],
    lossStreakDistribution: [],
    expectedMaxWinStreak: 0,
    expectedMaxLossStreak: 0,
    streakAnomalyScore: 0,
  };
}

/**
 * Format streak metrics for human-readable display.
 */
export function formatStreakMetrics(metrics: StreakMetrics): string {
  const lines = [
    `Current Streak:    ${metrics.currentStreakType === 'win' ? metrics.currentWinStreak : metrics.currentLossStreak} ${metrics.currentStreakType}`,
    `Max Win Streak:    ${metrics.maxWinStreak}`,
    `Max Loss Streak:   ${metrics.maxLossStreak}`,
    `Expected Max Win:  ${metrics.expectedMaxWinStreak.toFixed(2)}`,
    `Expected Max Loss: ${metrics.expectedMaxLossStreak.toFixed(2)}`,
    `Anomaly Score:     ${metrics.streakAnomalyScore.toFixed(3)}`,
  ];

  return lines.join('\n');
}
