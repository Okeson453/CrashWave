/**
 * Cash-Out Success Metrics — Success Rate & Failure Mode Analysis
 *
 * Computes cash-out success rate, categorizes failure modes,
 * tracks trends, and identifies degradation patterns.
 */

import { CashOutSuccessMetrics, BetOutcomeRecord } from '../types';
import { classifyCashOutTrend, CASHOUT_SUCCESS_THRESHOLDS } from '../constants';

/**
 * Compute cash-out success metrics from bet outcomes.
 *
 * @param outcomes — array of bet outcome records
 * @returns CashOutSuccessMetrics with full analysis
 */
export function computeCashOutSuccessMetrics(
  outcomes: BetOutcomeRecord[]
): CashOutSuccessMetrics {
  // Only consider bets where a cash-out was attempted
  // (win/loss outcomes had a cash-out attempt; failed/unknown may not have)
  const attempted = outcomes.filter(
    (o) => o.outcome === 'win' || o.outcome === 'loss' || o.cashOutSuccess !== null
  );

  if (attempted.length === 0) {
    return emptyCashOutSuccessMetrics();
  }

  const successfulCashouts = attempted.filter((o) => o.cashOutSuccess === true).length;
  const failedCashouts = attempted.filter((o) => o.cashOutSuccess === false).length;
  const totalAttempts = successfulCashouts + failedCashouts;

  const successRate = totalAttempts > 0 ? successfulCashouts / totalAttempts : 0;
  const failureRate = totalAttempts > 0 ? failedCashouts / totalAttempts : 0;

  // Categorize failure modes
  const failureModeBreakdown = categorizeFailureModes(attempted);

  const timeoutCount = failureModeBreakdown['timeout'] || 0;
  const prematureCrashCount = failureModeBreakdown['premature_crash'] || 0;
  const errorCount = failureModeBreakdown['error'] || 0;

  // Trend direction based on success rate thresholds
  const trendDirection = classifyCashOutTrend(successRate);

  return {
    successRate,
    failureRate,
    totalAttempts,
    successfulCashouts,
    failedCashouts,
    timeoutCount,
    prematureCrashCount,
    errorCount,
    trendDirection,
    failureModeBreakdown,
  };
}

/**
 * Categorize failure modes from bet outcome records.
 *
 * @param outcomes — bet outcomes with potential failure reasons
 * @returns Record mapping failure mode to count
 */
function categorizeFailureModes(outcomes: BetOutcomeRecord[]): Record<string, number> {
  const modes: Record<string, number> = {
    timeout: 0,
    premature_crash: 0,
    error: 0,
    unknown: 0,
    rejected: 0,
    network: 0,
  };

  for (const outcome of outcomes) {
    if (outcome.cashOutSuccess === true) continue;
    if (outcome.cashOutSuccess === null && outcome.outcome !== 'failed') continue;

    const reason = (outcome.failureReason || '').toLowerCase();

    if (reason.includes('timeout')) {
      modes['timeout']++;
    } else if (reason.includes('crash') || reason.includes('premature')) {
      modes['premature_crash']++;
    } else if (reason.includes('network') || reason.includes('connection')) {
      modes['network']++;
    } else if (reason.includes('reject') || reason.includes('denied')) {
      modes['rejected']++;
    } else if (reason.includes('error') || reason.includes('fail')) {
      modes['error']++;
    } else {
      modes['unknown']++;
    }
  }

  // Remove zero-count categories
  for (const key of Object.keys(modes)) {
    if (modes[key] === 0) {
      delete modes[key];
    }
  }

  return modes;
}

/**
 * Detect a cash-out failure spike — a sudden increase in failures.
 *
 * @param recentOutcomes — most recent bet outcomes
 * @param baselineOutcomes — historical baseline outcomes
 * @param thresholdMultiplier — multiplier above baseline to flag (default 3.0)
 * @returns true if a failure spike is detected
 */
export function detectCashOutFailureSpike(
  recentOutcomes: BetOutcomeRecord[],
  baselineOutcomes: BetOutcomeRecord[],
  thresholdMultiplier: number = 3.0
): boolean {
  const recentMetrics = computeCashOutSuccessMetrics(recentOutcomes);
  const baselineMetrics = computeCashOutSuccessMetrics(baselineOutcomes);

  if (recentMetrics.totalAttempts < 5 || baselineMetrics.totalAttempts < 10) {
    return false;
  }

  const recentFailureRate = recentMetrics.failureRate;
  const baselineFailureRate = baselineMetrics.failureRate;

  if (baselineFailureRate === 0) {
    return recentFailureRate > 0.05; // 5% failure rate is concerning
  }

  return recentFailureRate > baselineFailureRate * thresholdMultiplier;
}

/**
 * Check if cash-out success rate is critically low.
 *
 * @param metrics — cash-out success metrics
 * @returns true if success rate is below critical threshold
 */
export function isCashOutCritical(metrics: CashOutSuccessMetrics): boolean {
  return metrics.successRate < CASHOUT_SUCCESS_THRESHOLDS.critical;
}

/**
 * Check if cash-out success rate is acceptable.
 *
 * @param metrics — cash-out success metrics
 * @returns true if success rate is at least acceptable
 */
export function isCashOutAcceptable(metrics: CashOutSuccessMetrics): boolean {
  return metrics.successRate >= CASHOUT_SUCCESS_THRESHOLDS.acceptable;
}

/**
 * Compute cash-out success trend over time.
 *
 * @param outcomes — chronological bet outcomes
 * @param windowSize — number of outcomes per window
 * @returns array of { windowIndex, successRate }
 */
export function computeCashOutTrend(
  outcomes: BetOutcomeRecord[],
  windowSize: number = 50
): { windowIndex: number; successRate: number; sampleCount: number }[] {
  const results: { windowIndex: number; successRate: number; sampleCount: number }[] = [];

  for (let i = 0; i < outcomes.length; i += windowSize / 2) {
    const window = outcomes.slice(i, i + windowSize);
    const metrics = computeCashOutSuccessMetrics(window);

    if (metrics.totalAttempts > 0) {
      results.push({
        windowIndex: Math.floor(i / windowSize),
        successRate: metrics.successRate,
        sampleCount: metrics.totalAttempts,
      });
    }
  }

  return results;
}

/**
 * Return an empty cash-out success metrics object.
 */
function emptyCashOutSuccessMetrics(): CashOutSuccessMetrics {
  return {
    successRate: 0,
    failureRate: 0,
    totalAttempts: 0,
    successfulCashouts: 0,
    failedCashouts: 0,
    timeoutCount: 0,
    prematureCrashCount: 0,
    errorCount: 0,
    trendDirection: 'worsening',
    failureModeBreakdown: {},
  };
}

/**
 * Format cash-out success metrics for human-readable display.
 */
export function formatCashOutSuccessMetrics(metrics: CashOutSuccessMetrics): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  const lines = [
    `Success Rate:        ${pct(metrics.successRate)}`,
    `Failure Rate:        ${pct(metrics.failureRate)}`,
    `Total Attempts:      ${metrics.totalAttempts}`,
    `Successful:          ${metrics.successfulCashouts}`,
    `Failed:              ${metrics.failedCashouts}`,
    `Timeouts:            ${metrics.timeoutCount}`,
    `Premature Crashes:   ${metrics.prematureCrashCount}`,
    `Errors:              ${metrics.errorCount}`,
    `Trend:               ${metrics.trendDirection}`,
  ];

  if (Object.keys(metrics.failureModeBreakdown).length > 0) {
    lines.push('Failure Modes:');
    for (const [mode, count] of Object.entries(metrics.failureModeBreakdown)) {
      lines.push(`  - ${mode}: ${count}`);
    }
  }

  return lines.join('\n');
}
