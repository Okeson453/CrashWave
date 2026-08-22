/**
 * Hit Rate Metrics — Wilson Score Confidence Intervals
 *
 * Computes hit rate with Wilson score confidence intervals (not naive sample
 * proportion). The confidence interval correctly accounts for sample size,
 * preventing overinterpretation of small samples.
 *
 * Formula:
 *   z = 1.96 (for 95% confidence)
 *   denominator = 1 + z² / n
 *   center = (p + z² / (2n)) / denominator
 *   margin = z * sqrt((p*(1-p) + z²/(4n)) / n) / denominator
 *   lower = center - margin
 *   upper = center + margin
 */

import { HitRateMetrics, WilsonScoreInterval, BetOutcomeRecord } from '../types';
import {
  Z_SCORE_95,
  getBreakEvenHitRate,
  DEFAULT_TARGET,
} from '../constants';

/**
 * Calculate the Wilson score confidence interval for a binomial proportion.
 *
 * @param successes — number of successful outcomes
 * @param trials — total number of trials
 * @param confidenceLevel — confidence level (default 0.95)
 * @returns WilsonScoreInterval with center, margin, lower, upper bounds
 */
export function wilsonScoreInterval(
  successes: number,
  trials: number,
  confidenceLevel: number = 0.95
): WilsonScoreInterval {
  // Validate inputs
  if (trials < 0 || successes < 0 || successes > trials) {
    return {
      confidenceLevel,
      lower: 0,
      upper: 0,
      margin: 0,
      sampleSize: trials,
      isValid: false,
      center: 0,
      zScore: 0,
    };
  }

  // Edge case: no trials
  if (trials === 0) {
    return {
      confidenceLevel,
      lower: 0,
      upper: 1,
      margin: 0.5,
      sampleSize: 0,
      isValid: false,
      center: 0.5,
      zScore: getZScore(confidenceLevel),
    };
  }

  // Edge case: all successes or all failures
  if (successes === 0) {
    const z = getZScore(confidenceLevel);
    const lower = 0;
    const upper = 1 - Math.pow(0.5, 1 / trials); // Rule of three approximation
    return {
      confidenceLevel,
      lower,
      upper: Math.min(upper, 1),
      margin: upper / 2,
      sampleSize: trials,
      isValid: true,
      center: upper / 2,
      zScore: z,
    };
  }

  if (successes === trials) {
    const z = getZScore(confidenceLevel);
    const lower = Math.pow(0.5, 1 / trials);
    const upper = 1;
    return {
      confidenceLevel,
      lower: Math.max(lower, 0),
      upper,
      margin: (1 - lower) / 2,
      sampleSize: trials,
      isValid: true,
      center: (1 + lower) / 2,
      zScore: z,
    };
  }

  const p = successes / trials;
  const z = getZScore(confidenceLevel);
  const z2 = z * z;
  const n = trials;

  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denominator;

  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);

  return {
    confidenceLevel,
    lower,
    upper,
    margin,
    sampleSize: trials,
    isValid: true,
    center,
    zScore: z,
  };
}

/**
 * Get the z-score for a given confidence level.
 * Uses exact values for common levels, approximation otherwise.
 */
function getZScore(confidenceLevel: number): number {
  if (confidenceLevel === 0.95) return Z_SCORE_95;
  if (confidenceLevel === 0.90) return 1.6448536269514722;
  if (confidenceLevel === 0.99) return 2.5758293035489004;
  if (confidenceLevel === 0.999) return 3.2905267314919255;

  // Approximate z-score using inverse error function
  // z = sqrt(2) * erf^{-1}(2*confidenceLevel - 1)
  const p = 1 - (1 - confidenceLevel) / 2;
  return approximateInverseErf(2 * p - 1) * Math.SQRT2;
}

/**
 * Approximate the inverse error function using a rational approximation.
 * Abramowitz & Stegun formula 7.1.26.
 */
function approximateInverseErf(x: number): number {
  const a = 0.147;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);

  const ln1mx2 = Math.log(1 - absX * absX);
  const term = (2 / (Math.PI * a) + ln1mx2 / 2);
  const sqrtTerm = Math.sqrt(-ln1mx2 / a + term * term);

  return sign * Math.sqrt(-ln1mx2 / a + sqrtTerm - term);
}

/**
 * Compute hit rate metrics including Wilson score confidence interval,
 * break-even comparison, and statistical significance assessment.
 *
 * @param outcomes — array of bet outcome records
 * @param target — cash-out target (default 1.30)
 * @param confidenceLevel — confidence level for interval (default 0.95)
 * @returns HitRateMetrics with full statistical analysis
 */
export function computeHitRateMetrics(
  outcomes: BetOutcomeRecord[],
  target: number = DEFAULT_TARGET,
  confidenceLevel: number = 0.95
): HitRateMetrics {
  // Filter to resolved outcomes only (win/loss)
  const resolved = outcomes.filter(
    (o) => o.outcome === 'win' || o.outcome === 'loss'
  );

  const successes = resolved.filter((o) => o.outcome === 'win').length;
  const trials = resolved.length;
  const observedRate = trials > 0 ? successes / trials : 0;
  const breakEvenRate = getBreakEvenHitRate(target);

  const ci = wilsonScoreInterval(successes, trials, confidenceLevel);

  // Determine if observed rate is above break-even
  const isAboveBreakEven = observedRate > breakEvenRate;

  // Check if break-even rate falls within the confidence interval
  const breakEvenWithinCI = ci.lower <= breakEvenRate && ci.upper >= breakEvenRate;

  // Statistical significance assessment
  let statisticalSignificance: HitRateMetrics['statisticalSignificance'];

  if (trials < 10) {
    statisticalSignificance = 'insufficient_data';
  } else if (ci.lower > breakEvenRate) {
    statisticalSignificance = 'significant_above';
  } else if (ci.upper < breakEvenRate) {
    statisticalSignificance = 'significant_below';
  } else {
    statisticalSignificance = 'inconclusive';
  }

  return {
    observedRate,
    breakEvenRate,
    confidenceInterval: ci,
    sampleSize: trials,
    isAboveBreakEven,
    breakEvenWithinCI,
    statisticalSignificance,
  };
}

/**
 * Compute hit rate from simple win/loss counts.
 *
 * @param wins — number of wins
 * @param losses — number of losses
 * @param target — cash-out target
 * @param confidenceLevel — confidence level
 * @returns HitRateMetrics
 */
export function computeHitRateFromCounts(
  wins: number,
  losses: number,
  target: number = DEFAULT_TARGET,
  confidenceLevel: number = 0.95
): HitRateMetrics {
  const outcomes: BetOutcomeRecord[] = [];

  for (let i = 0; i < wins; i++) {
    outcomes.push({
      betId: `win-${i}`,
      roundId: `round-${i}`,
      dailyKey: 'aggregate',
      timestamp: new Date().toISOString(),
      outcome: 'win',
      pnl: 210,
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
      betId: `loss-${i}`,
      roundId: `round-${i + wins}`,
      dailyKey: 'aggregate',
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

  return computeHitRateMetrics(outcomes, target, confidenceLevel);
}

/**
 * Check if a hit rate is statistically significantly above break-even.
 * Returns true only if the lower bound of the confidence interval exceeds
 * the break-even rate, indicating high confidence of profitability.
 */
export function isSignificantlyProfitable(
  metrics: HitRateMetrics
): boolean {
  if (!metrics.confidenceInterval.isValid) return false;
  if (metrics.sampleSize < 30) return false; // Require minimum sample size
  return metrics.confidenceInterval.lower > metrics.breakEvenRate;
}

/**
 * Check if a hit rate is statistically significantly below break-even.
 * Returns true only if the upper bound of the confidence interval is below
 * the break-even rate, indicating high confidence of unprofitability.
 */
export function isSignificantlyUnprofitable(
  metrics: HitRateMetrics
): boolean {
  if (!metrics.confidenceInterval.isValid) return false;
  if (metrics.sampleSize < 30) return false;
  return metrics.confidenceInterval.upper < metrics.breakEvenRate;
}

/**
 * Format hit rate metrics for human-readable display.
 */
export function formatHitRateMetrics(metrics: HitRateMetrics): string {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const ci = metrics.confidenceInterval;

  const lines = [
    `Observed Hit Rate: ${pct(metrics.observedRate)}`,
    `Break-Even Rate:   ${pct(metrics.breakEvenRate)}`,
    `Sample Size:       ${metrics.sampleSize}`,
    `95% CI:            [${pct(ci.lower)}, ${pct(ci.upper)}]`,
    `Status:            ${metrics.statisticalSignificance}`,
  ];

  return lines.join('\n');
}
