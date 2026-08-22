/**
 * Expected Value Metrics — Theoretical vs Realized P&L Analysis
 *
 * Computes expected value using the formula:
 *   EV = S * (p * T - 1)
 *
 * Where:
 *   S = stake per entry
 *   p = observed hit rate (probability of reaching target)
 *   T = cash-out target
 *
 * Compares theoretical EV against realized P&L to measure accuracy.
 * Also computes variance, standard error, and confidence intervals.
 */

import { ExpectedValueMetrics, ConfidenceInterval, BetOutcomeRecord } from '../types';
import { getExpectedValue, DEFAULT_STAKE, DEFAULT_TARGET } from '../constants';

/**
 * Compute expected value metrics from bet outcomes.
 *
 * Uses the formula: EV = S * (p * T - 1)
 * Where p is the observed hit rate from resolved bets.
 *
 * @param outcomes — array of bet outcome records
 * @param stake — stake per entry (default 700)
 * @param target — cash-out target (default 1.30)
 * @returns ExpectedValueMetrics with full analysis
 */
export function computeExpectedValueMetrics(
  outcomes: BetOutcomeRecord[],
  stake: number = DEFAULT_STAKE,
  target: number = DEFAULT_TARGET
): ExpectedValueMetrics {
  const resolved = outcomes.filter(
    (o) => o.outcome === 'win' || o.outcome === 'loss'
  );

  const n = resolved.length;

  if (n === 0) {
    return emptyExpectedValueMetrics();
  }

  const wins = resolved.filter((o) => o.outcome === 'win').length;
  const hitRate = wins / n;

  // Theoretical EV per entry
  const theoreticalEvPerEntry = getExpectedValue(stake, hitRate, target);

  // Realized EV per entry (average actual P&L)
  const totalRealizedPnl = resolved.reduce((sum, o) => sum + o.pnl, 0);
  const realizedEvPerEntry = totalRealizedPnl / n;

  // Cumulative values
  const cumulativeExpectedPnl = theoreticalEvPerEntry * n;
  const cumulativeRealizedPnl = totalRealizedPnl;

  // Variance of individual outcomes
  const evVariance = computeVariance(resolved, realizedEvPerEntry);

  // Standard error of the mean
  const evStandardError = Math.sqrt(evVariance / n);

  // 95% confidence interval for the realized EV
  const evConfidenceInterval = computeEvConfidenceInterval(
    realizedEvPerEntry,
    evStandardError,
    n
  );

  // EV accuracy: how close is realized to theoretical?
  // 1.0 = perfect match, <1.0 = underperforming, >1.0 = overperforming
  const evAccuracy =
    cumulativeExpectedPnl !== 0
      ? cumulativeRealizedPnl / cumulativeExpectedPnl
      : 0;

  return {
    theoreticalEvPerEntry,
    realizedEvPerEntry,
    cumulativeExpectedPnl,
    cumulativeRealizedPnl,
    evVariance,
    evStandardError,
    evConfidenceInterval,
    evAccuracy,
  };
}

/**
 * Compute expected value from simple counts.
 *
 * @param wins — number of wins
 * @param losses — number of losses
 * @param stake — stake per entry
 * @param target — cash-out target
 * @returns ExpectedValueMetrics
 */
export function computeExpectedValueFromCounts(
  wins: number,
  losses: number,
  stake: number = DEFAULT_STAKE,
  target: number = DEFAULT_TARGET
): ExpectedValueMetrics {
  const n = wins + losses;

  if (n === 0) {
    return emptyExpectedValueMetrics();
  }

  const hitRate = wins / n;
  const winProfit = stake * (target - 1);
  const lossAmount = -stake;

  const theoreticalEvPerEntry = getExpectedValue(stake, hitRate, target);
  const realizedEvPerEntry = (wins * winProfit + losses * lossAmount) / n;
  const cumulativeExpectedPnl = theoreticalEvPerEntry * n;
  const cumulativeRealizedPnl = wins * winProfit + losses * lossAmount;

  // Variance for binomial outcomes
  const evVariance =
    n > 0
      ? (wins * Math.pow(winProfit - realizedEvPerEntry, 2) +
          losses * Math.pow(lossAmount - realizedEvPerEntry, 2)) /
        n
      : 0;

  const evStandardError = Math.sqrt(evVariance / n);
  const evConfidenceInterval = computeEvConfidenceInterval(
    realizedEvPerEntry,
    evStandardError,
    n
  );

  const evAccuracy =
    cumulativeExpectedPnl !== 0
      ? cumulativeRealizedPnl / cumulativeExpectedPnl
      : 0;

  return {
    theoreticalEvPerEntry,
    realizedEvPerEntry,
    cumulativeExpectedPnl,
    cumulativeRealizedPnl,
    evVariance,
    evStandardError,
    evConfidenceInterval,
    evAccuracy,
  };
}

/**
 * Compute variance of a set of P&L outcomes.
 */
function computeVariance(outcomes: BetOutcomeRecord[], mean: number): number {
  if (outcomes.length === 0) return 0;

  const sumSquaredDiffs = outcomes.reduce((sum, o) => {
    const diff = o.pnl - mean;
    return sum + diff * diff;
  }, 0);

  return sumSquaredDiffs / outcomes.length;
}

/**
 * Compute a confidence interval for the realized EV per entry.
 */
function computeEvConfidenceInterval(
  mean: number,
  standardError: number,
  n: number
): ConfidenceInterval {
  const z = 1.96; // 95% confidence
  const margin = z * standardError;

  return {
    confidenceLevel: 0.95,
    lower: mean - margin,
    upper: mean + margin,
    margin,
    sampleSize: n,
    isValid: n >= 2,
  };
}

/**
 * Compute the break-even hit rate for a given target.
 */
export function computeBreakEvenHitRate(target: number): number {
  if (target <= 1) return 1.0;
  return 1 / target;
}

/**
 * Compute the required hit rate to achieve a target EV per entry.
 *
 * p_required = (EV/S + 1) / T
 */
export function computeRequiredHitRate(
  targetEv: number,
  stake: number,
  target: number
): number {
  if (target <= 0 || stake <= 0) return 1.0;
  return (targetEv / stake + 1) / target;
}

/**
 * Check if the realized P&L is within the expected range given variance.
 *
 * @param metrics — expected value metrics
 * @param sigmaThreshold — number of standard deviations (default 2)
 * @returns true if realized is within expected range
 */
export function isRealizedWithinExpectedRange(
  metrics: ExpectedValueMetrics,
  sigmaThreshold: number = 2
): boolean {
  if (!metrics.evConfidenceInterval.isValid) return true;

  const expected = metrics.cumulativeExpectedPnl;
  const realized = metrics.cumulativeRealizedPnl;
  const stdDev = Math.sqrt(metrics.evVariance * metrics.evConfidenceInterval.sampleSize);

  if (stdDev === 0) return expected === realized;

  const deviation = Math.abs(realized - expected) / stdDev;
  return deviation <= sigmaThreshold;
}

/**
 * Return an empty expected value metrics object.
 */
function emptyExpectedValueMetrics(): ExpectedValueMetrics {
  return {
    theoreticalEvPerEntry: 0,
    realizedEvPerEntry: 0,
    cumulativeExpectedPnl: 0,
    cumulativeRealizedPnl: 0,
    evVariance: 0,
    evStandardError: 0,
    evConfidenceInterval: {
      confidenceLevel: 0.95,
      lower: 0,
      upper: 0,
      margin: 0,
      sampleSize: 0,
      isValid: false,
    },
    evAccuracy: 0,
  };
}

/**
 * Format expected value metrics for human-readable display.
 */
export function formatExpectedValueMetrics(metrics: ExpectedValueMetrics): string {
  const ci = metrics.evConfidenceInterval;
  const lines = [
    `Theoretical EV/entry: ${metrics.theoreticalEvPerEntry.toFixed(2)}`,
    `Realized EV/entry:    ${metrics.realizedEvPerEntry.toFixed(2)}`,
    `Expected P&L:         ${metrics.cumulativeExpectedPnl.toFixed(2)}`,
    `Realized P&L:         ${metrics.cumulativeRealizedPnl.toFixed(2)}`,
    `EV Accuracy:          ${(metrics.evAccuracy * 100).toFixed(1)}%`,
    `Std Error:            ${metrics.evStandardError.toFixed(2)}`,
    `95% CI:               [${ci.lower.toFixed(2)}, ${ci.upper.toFixed(2)}]`,
  ];

  return lines.join('\n');
}
