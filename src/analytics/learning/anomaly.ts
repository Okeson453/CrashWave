/**
 * Anomaly Detection — Statistical Deviation Flagging
 *
 * Flags statistical deviations without excessive false positives.
 * Thresholds are configurable per anomaly category.
 *
 * Uses z-score based detection: flag if observed value deviates
 * from expected by more than thresholdSigma standard deviations.
 *
 * Categories:
 * - hit_rate_drop: sudden drop in hit rate
 * - cashout_failure_spike: sudden increase in cash-out failures
 * - latency_spike: observation/execution latency increase
 * - balance_mismatch: balance doesn't match ledger
 * - losing_streak: unusually long losing streak
 * - failed_entry_spike: sudden increase in failed bet placements
 * - observation_degradation: observation confidence drop
 * - reconnect_loop: repeated reconnections
 * - unknown_outcome_spike: increase in unknown bet outcomes
 * - drawdown_spike: sudden increase in drawdown
 */

import {
  AnomalyFlag,
  AnomalyCategory,
  AnomalyConfig,
  BetOutcomeRecord,
  HitRateMetrics,
  DrawdownMetrics,
  StreakMetrics,
  LatencyMetrics,
  CashOutSuccessMetrics,
  WindowType,
} from '../types';
import { DEFAULT_ANOMALY_CONFIG } from '../constants';

export interface AnomalyInput {
  outcomes: BetOutcomeRecord[];
  hitRate: HitRateMetrics;
  drawdown: DrawdownMetrics;
  streaks: StreakMetrics;
  latency: LatencyMetrics;
  cashOutSuccess: CashOutSuccessMetrics;
  window: WindowType;
  previousOutcomes?: BetOutcomeRecord[]; // for trend comparison
  balanceMismatch?: { observed: number; expected: number; difference: number };
  reconnectCount?: number;
  observationConfidence?: 'high' | 'medium' | 'low';
}

// Track last anomaly timestamps to enforce cooldowns
const lastAnomalyTimestamps = new Map<AnomalyCategory, string>();

/**
 * Detect anomalies from current metrics.
 *
 * @param input — current metric snapshot and raw data
 * @param config — anomaly detection configuration
 * @returns array of AnomalyFlag objects
 */
export function detectAnomalies(
  input: AnomalyInput,
  config: AnomalyConfig = DEFAULT_ANOMALY_CONFIG
): AnomalyFlag[] {
  if (!config.enabled) return [];

  const flags: AnomalyFlag[] = [];
  const timestamp = new Date().toISOString();

  // 1. Hit rate drop
  const hitRateConfig = config.categories?.hit_rate_drop;
  if (hitRateConfig?.enabled && input.hitRate.sampleSize >= (hitRateConfig.minSamples ?? 50)) {
    const expectedHitRate = input.hitRate.breakEvenRate;
    const observedHitRate = input.hitRate.observedRate;
    const sigma = computeZScore(observedHitRate, expectedHitRate, input.hitRate.sampleSize);

    if (sigma < -(hitRateConfig.thresholdSigma ?? 2.5)) {
      const flag = createAnomalyFlag({
        category: 'hit_rate_drop',
        severity: sigma < -3.5 ? 'critical' : 'moderate',
        message: `Hit rate dropped to ${(observedHitRate * 100).toFixed(1)}%, ${Math.abs(sigma).toFixed(1)} sigma below break-even ${(expectedHitRate * 100).toFixed(1)}%`,
        metricName: 'hit_rate',
        observedValue: observedHitRate,
        expectedValue: expectedHitRate,
        deviationSigma: Math.abs(sigma),
        threshold: hitRateConfig.thresholdSigma ?? 2.5,
        timestamp,
        window: input.window,
        recommendedAction: 'Switch to dry-run mode and observe more rounds.',
      });

      if (!isInCooldown(flag, hitRateConfig.cooldownMs ?? 300000)) {
        flags.push(flag);
      }
    }
  }

  // 2. Cash-out failure spike
  const cashoutConfig = config.categories?.cashout_failure_spike;
  if (
    cashoutConfig?.enabled &&
    input.cashOutSuccess.totalAttempts >= (cashoutConfig.minSamples ?? 20)
  ) {
    const failureRate = input.cashOutSuccess.failureRate;
    const expectedFailureRate = 0.02; // 2% baseline expectation
    const sigma = computeZScoreForProportion(
      failureRate,
      expectedFailureRate,
      input.cashOutSuccess.totalAttempts
    );

    if (sigma > (cashoutConfig.thresholdSigma ?? 2.0)) {
      const flag = createAnomalyFlag({
        category: 'cashout_failure_spike',
        severity: failureRate > 0.1 ? 'critical' : 'moderate',
        message: `Cash-out failure rate spiked to ${(failureRate * 100).toFixed(1)}%, ${sigma.toFixed(1)} sigma above baseline`,
        metricName: 'cashout_failure_rate',
        observedValue: failureRate,
        expectedValue: expectedFailureRate,
        deviationSigma: sigma,
        threshold: cashoutConfig.thresholdSigma ?? 2.0,
        timestamp,
        window: input.window,
        recommendedAction: 'Stop betting immediately and investigate cash-out execution pipeline.',
      });

      if (!isInCooldown(flag, cashoutConfig.cooldownMs ?? 180000)) {
        flags.push(flag);
      }
    }
  }

  // 3. Latency spike
  const latencyConfig = config.categories?.latency_spike;
  if (latencyConfig?.enabled && input.latency.sampleCount >= (latencyConfig.minSamples ?? 30)) {
    const p95 = input.latency.p95;
    const expectedP95 = 500; // 500ms baseline
    const sigma = computeZScore(p95, expectedP95, input.latency.sampleCount);

    if (sigma > (latencyConfig.thresholdSigma ?? 3.0)) {
      const flag = createAnomalyFlag({
        category: 'latency_spike',
        severity: p95 > 2000 ? 'critical' : 'moderate',
        message: `P95 latency spiked to ${p95.toFixed(0)}ms, ${sigma.toFixed(1)} sigma above baseline`,
        metricName: 'latency_p95',
        observedValue: p95,
        expectedValue: expectedP95,
        deviationSigma: sigma,
        threshold: latencyConfig.thresholdSigma ?? 3.0,
        timestamp,
        window: input.window,
        recommendedAction: 'Pause betting and investigate network/browser performance.',
      });

      if (!isInCooldown(flag, latencyConfig.cooldownMs ?? 120000)) {
        flags.push(flag);
      }
    }
  }

  // 4. Balance mismatch
  const balanceConfig = config.categories?.balance_mismatch;
  if (balanceConfig?.enabled && input.balanceMismatch) {
    const diff = Math.abs(input.balanceMismatch.difference);
    const tolerance = input.balanceMismatch.expected * 0.01; // 1% tolerance

    if (diff > tolerance) {
      const flag = createAnomalyFlag({
        category: 'balance_mismatch',
        severity: diff > tolerance * 5 ? 'critical' : 'moderate',
        message: `Balance mismatch detected: observed ${input.balanceMismatch.observed.toFixed(2)} vs expected ${input.balanceMismatch.expected.toFixed(2)} (diff: ${input.balanceMismatch.difference.toFixed(2)})`,
        metricName: 'balance_difference',
        observedValue: diff,
        expectedValue: tolerance,
        deviationSigma: diff / tolerance,
        threshold: balanceConfig.thresholdSigma ?? 2.0,
        timestamp,
        window: input.window,
        recommendedAction: 'Stop betting and perform full reconciliation.',
      });

      if (!isInCooldown(flag, balanceConfig.cooldownMs ?? 60000)) {
        flags.push(flag);
      }
    }
  }

  // 5. Losing streak
  const streakConfig = config.categories?.losing_streak;
  if (streakConfig?.enabled && input.streaks.currentLossStreak >= 3) {
    const resolved = input.outcomes.filter((o) => o.outcome === 'win' || o.outcome === 'loss');
    const n = resolved.length;
    const lossRate = resolved.filter((o) => o.outcome === 'loss').length / n;

    const expectedMaxLossStreak = expectedMaxStreakLength(n, lossRate);
    const deviation = input.streaks.currentLossStreak - expectedMaxLossStreak;
    const sigma = deviation > 0 ? deviation : 0;

    if (sigma > (streakConfig.thresholdSigma ?? 2.5)) {
      const flag = createAnomalyFlag({
        category: 'losing_streak',
        severity: input.streaks.currentLossStreak > 8 ? 'critical' : 'moderate',
        message: `Losing streak of ${input.streaks.currentLossStreak} bets, expected max was ${expectedMaxLossStreak.toFixed(1)}`,
        metricName: 'loss_streak_length',
        observedValue: input.streaks.currentLossStreak,
        expectedValue: expectedMaxLossStreak,
        deviationSigma: sigma,
        threshold: streakConfig.thresholdSigma ?? 2.5,
        timestamp,
        window: input.window,
        recommendedAction: 'Consider switching to dry-run mode until streak ends.',
      });

      if (!isInCooldown(flag, streakConfig.cooldownMs ?? 300000)) {
        flags.push(flag);
      }
    }
  }

  // 6. Failed entry spike
  const failedConfig = config.categories?.failed_entry_spike;
  if (failedConfig?.enabled) {
    const failed = input.outcomes.filter((o) => o.outcome === 'failed').length;
    const total = input.outcomes.length;

    if (total >= (failedConfig.minSamples ?? 10)) {
      const failedRate = failed / total;
      const expectedFailedRate = 0.01; // 1% baseline
      const sigma = computeZScoreForProportion(failedRate, expectedFailedRate, total);

      if (sigma > (failedConfig.thresholdSigma ?? 2.0)) {
        const flag = createAnomalyFlag({
          category: 'failed_entry_spike',
          severity: failedRate > 0.1 ? 'critical' : 'moderate',
          message: `Failed entry rate spiked to ${(failedRate * 100).toFixed(1)}%, ${sigma.toFixed(1)} sigma above baseline`,
          metricName: 'failed_entry_rate',
          observedValue: failedRate,
          expectedValue: expectedFailedRate,
          deviationSigma: sigma,
          threshold: failedConfig.thresholdSigma ?? 2.0,
          timestamp,
          window: input.window,
          recommendedAction: 'Review bet placement logic and game state detection.',
        });

        if (!isInCooldown(flag, failedConfig.cooldownMs ?? 180000)) {
          flags.push(flag);
        }
      }
    }
  }

  // 7. Observation degradation
  const obsConfig = config.categories?.observation_degradation;
  if (obsConfig?.enabled && input.observationConfidence && input.observationConfidence !== 'high') {
    const flag = createAnomalyFlag({
      category: 'observation_degradation',
      severity: input.observationConfidence === 'low' ? 'critical' : 'moderate',
      message: `Observation confidence degraded to ${input.observationConfidence}`,
      metricName: 'observation_confidence',
      observedValue: input.observationConfidence === 'low' ? 0 : 0.5,
      expectedValue: 1.0, // high = 1.0
      deviationSigma: input.observationConfidence === 'low' ? 3 : 2,
      threshold: obsConfig.thresholdSigma ?? 2.0,
      timestamp,
      window: input.window,
      recommendedAction: 'Switch to observe-only mode until confidence is restored.',
    });

    if (!isInCooldown(flag, obsConfig.cooldownMs ?? 120000)) {
      flags.push(flag);
    }
  }

  // 8. Reconnect loop
  const reconnectConfig = config.categories?.reconnect_loop;
  if (reconnectConfig?.enabled && input.reconnectCount && input.reconnectCount >= 3) {
    const flag = createAnomalyFlag({
      category: 'reconnect_loop',
      severity: input.reconnectCount > 5 ? 'critical' : 'moderate',
      message: `${input.reconnectCount} reconnections detected in recent window`,
      metricName: 'reconnect_count',
      observedValue: input.reconnectCount,
      expectedValue: 0,
      deviationSigma: input.reconnectCount,
      threshold: reconnectConfig.thresholdSigma ?? 2.0,
      timestamp,
      window: input.window,
      recommendedAction: 'Investigate network stability and WebSocket connection health.',
    });

    if (!isInCooldown(flag, reconnectConfig.cooldownMs ?? 60000)) {
      flags.push(flag);
    }
  }

  // 9. Unknown outcome spike
  const unknownConfig = config.categories?.unknown_outcome_spike;
  if (unknownConfig?.enabled) {
    const unknown = input.outcomes.filter((o) => o.outcome === 'unknown').length;
    const total = input.outcomes.length;

    if (total >= (unknownConfig.minSamples ?? 10)) {
      const unknownRate = unknown / total;
      const expectedUnknownRate = 0.005; // 0.5% baseline
      const sigma = computeZScoreForProportion(unknownRate, expectedUnknownRate, total);

      if (sigma > (unknownConfig.thresholdSigma ?? 2.0)) {
        const flag = createAnomalyFlag({
          category: 'unknown_outcome_spike',
          severity: unknownRate > 0.05 ? 'critical' : 'moderate',
          message: `Unknown outcome rate spiked to ${(unknownRate * 100).toFixed(1)}%, ${sigma.toFixed(1)} sigma above baseline`,
          metricName: 'unknown_outcome_rate',
          observedValue: unknownRate,
          expectedValue: expectedUnknownRate,
          deviationSigma: sigma,
          threshold: unknownConfig.thresholdSigma ?? 2.0,
          timestamp,
          window: input.window,
          recommendedAction: 'Investigate bet state tracking and reconciliation logic.',
        });

        if (!isInCooldown(flag, unknownConfig.cooldownMs ?? 180000)) {
          flags.push(flag);
        }
      }
    }
  }

  // 10. Drawdown spike
  const ddConfig = config.categories?.drawdown_spike;
  if (ddConfig?.enabled && input.drawdown.maxDrawdown > 0) {
    const resolved = input.outcomes.filter((o) => o.outcome === 'win' || o.outcome === 'loss');
    const n = resolved.length;

    if (n >= (ddConfig.minSamples ?? 20)) {
      // Expected max drawdown for random walk with given win/loss distribution
      const wins = resolved.filter((o) => o.outcome === 'win').length;
      const winRate = wins / n;
      const expectedMaxDD = estimateExpectedMaxDrawdown(n, winRate, 210, 700); // S=700, T=1.30
      const sigma = input.drawdown.maxDrawdown / Math.max(expectedMaxDD, 1);

      if (sigma > (ddConfig.thresholdSigma ?? 2.5)) {
        const flag = createAnomalyFlag({
          category: 'drawdown_spike',
          severity: input.drawdown.drawdownSeverity === 'critical' ? 'critical' : 'moderate',
          message: `Max drawdown of ${input.drawdown.maxDrawdown.toFixed(2)} is ${sigma.toFixed(1)}x expected max ${expectedMaxDD.toFixed(2)}`,
          metricName: 'max_drawdown',
          observedValue: input.drawdown.maxDrawdown,
          expectedValue: expectedMaxDD,
          deviationSigma: sigma,
          threshold: ddConfig.thresholdSigma ?? 2.5,
          timestamp,
          window: input.window,
          recommendedAction: 'Consider stopping for the day to preserve bankroll.',
        });

        if (!isInCooldown(flag, ddConfig.cooldownMs ?? 300000)) {
          flags.push(flag);
        }
      }
    }
  }

  return flags;
}

/**
 * Create an anomaly flag with a unique ID.
 */
function createAnomalyFlag(params: Omit<AnomalyFlag, 'id'>): AnomalyFlag {
  const id = `${params.category}-${params.timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, ...params };
}

/**
 * Check if an anomaly category is in cooldown.
 */
function isInCooldown(flag: AnomalyFlag, cooldownMs: number): boolean {
  const lastTimestamp = lastAnomalyTimestamps.get(flag.category);
  if (!lastTimestamp) {
    lastAnomalyTimestamps.set(flag.category, flag.timestamp);
    return false;
  }

  const lastTime = new Date(lastTimestamp).getTime();
  const currentTime = new Date(flag.timestamp).getTime();

  if (currentTime - lastTime < cooldownMs) {
    return true;
  }

  lastAnomalyTimestamps.set(flag.category, flag.timestamp);
  return false;
}

/**
 * Compute z-score for a sample mean.
 */
function computeZScore(observed: number, expected: number, sampleSize: number): number {
  if (sampleSize <= 0) return 0;
  let se: number;
  if (expected > 0 && expected <= 1) {
    // Standard error for proportion-like metrics
    se = Math.sqrt(expected * (1 - expected) / sampleSize);
  } else {
    // For non-proportion metrics (latency, drawdown), use CV approach
    // Assume 20% coefficient of variation as baseline
    const cv = 0.20;
    se = expected * cv / Math.sqrt(sampleSize);
  }
  if (se === 0 || !isFinite(se)) return 0;
  return (observed - expected) / se;
}

/**
 * Compute z-score for a proportion with a given baseline.
 */
function computeZScoreForProportion(
  observedRate: number,
  expectedRate: number,
  sampleSize: number
): number {
  if (sampleSize <= 0) return 0;
  const se = Math.sqrt((expectedRate * (1 - expectedRate)) / sampleSize);
  if (se === 0) return 0;
  return (observedRate - expectedRate) / se;
}

/**
 * Estimate expected maximum streak length.
 */
function expectedMaxStreakLength(n: number, p: number): number {
  if (n <= 0 || p <= 0 || p >= 1) return 1;
  const eulerMascheroni = 0.5772156649015329;
  const logDenom = Math.log(1 / p);
  return Math.max(1, Math.log(n * (1 - p)) / logDenom + eulerMascheroni / logDenom - 0.5);
}

/**
 * Estimate expected maximum drawdown for a simple random walk.
 *
 * Uses a simplified approximation based on the gambler's ruin problem.
 */
function estimateExpectedMaxDrawdown(
  n: number,
  winRate: number,
  winAmount: number,
  lossAmount: number
): number {
  if (winRate >= 1) return 0;
  const expectedReturn = winRate * winAmount - (1 - winRate) * lossAmount;
  const variance = winRate * Math.pow(winAmount - expectedReturn, 2) + (1 - winRate) * Math.pow(-lossAmount - expectedReturn, 2);
  const stdDev = Math.sqrt(variance);

  // Approximate expected max drawdown for a random walk
  // E[max DD] ≈ std_dev * sqrt(2 * log(n)) for a driftless walk
  // Adjust for drift
  const driftAdjustment = expectedReturn >= 0 ? 1 : 1 + Math.abs(expectedReturn) / stdDev;
  return stdDev * Math.sqrt(2 * Math.log(Math.max(n, 2))) * driftAdjustment;
}

/**
 * Clear all anomaly cooldowns. Useful for testing.
 */
export function clearAnomalyCooldowns(): void {
  lastAnomalyTimestamps.clear();
}

/**
 * Format anomaly flags for human-readable display.
 */
export function formatAnomalyFlags(flags: AnomalyFlag[]): string {
  if (flags.length === 0) {
    return 'No anomalies detected.';
  }

  const lines: string[] = [];

  for (const flag of flags) {
    const emoji =
      flag.severity === 'critical' ? '🔴' : flag.severity === 'moderate' ? '🟡' : '🟠';

    lines.push(
      `${emoji} **${flag.category}** (${flag.severity})`,
      `   ${flag.message}`,
      `   Deviation: ${flag.deviationSigma.toFixed(2)} sigma (threshold: ${flag.threshold})`,
      `   Action: ${flag.recommendedAction}`,
      ''
    );
  }

  return lines.join('\n');
}
