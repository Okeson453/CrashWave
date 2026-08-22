/**
 * Recommendation Engine — Conservative, Rule-Based Advice
 *
 * Generates conservative recommendations based on statistical metrics.
 * NEVER recommends increasing stake or target. Only recommends:
 * - continue (metrics look acceptable)
 * - pause (temporary halt, review needed)
 * - dry_run (switch to simulation mode)
 * - stop (halt for the day)
 * - review (examine specific issue)
 * - reduce_exposure (lower risk)
 *
 * Rules:
 * - IF hit_rate < break-even AND P&L < 0 → recommend pause or dry-run
 * - IF cashout_failure_rate > 2% → recommend immediate stop
 * - IF max_drawdown > operator_limit → recommend stopping for the day
 * - IF observation_confidence < high → recommend observe-only
 * - IF balance < stake * 10 → recommend reducing exposure
 */

import {
  Recommendation,
  RecommendationType,
  RecommendationEngineConfig,
  HitRateMetrics,
  DrawdownMetrics,
  StreakMetrics,
  CashOutSuccessMetrics,
  ExpectedValueMetrics,
  WindowType,
} from '../types';
import {
  DEFAULT_RECOMMENDATION_CONFIG,
  DEFAULT_STAKE,
  CASHOUT_SUCCESS_THRESHOLDS,
} from '../constants';

export interface RecommendationInput {
  hitRate: HitRateMetrics;
  drawdown: DrawdownMetrics;
  streaks: StreakMetrics;
  cashOutSuccess: CashOutSuccessMetrics;
  expectedValue: ExpectedValueMetrics;
  window: WindowType;
  currentBalance?: number;
  observationConfidence?: 'high' | 'medium' | 'low';
  consecutiveErrors?: number;
  mode?: 'live' | 'dry-run' | 'observe-only';
}

/**
 * Generate recommendations based on current metrics.
 *
 * @param input — current metric snapshot
 * @param config — recommendation engine configuration
 * @returns array of Recommendations, sorted by priority
 */
export function generateRecommendations(
  input: RecommendationInput,
  config: RecommendationEngineConfig = DEFAULT_RECOMMENDATION_CONFIG
): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const triggeredBy: string[] = [];
  const timestamp = new Date().toISOString();

  // Rule 1: Cash-out failure rate is critical
  // If cash-out success rate drops below critical threshold, recommend immediate stop
  if (input.cashOutSuccess.totalAttempts >= 10) {
    if (input.cashOutSuccess.successRate < CASHOUT_SUCCESS_THRESHOLDS.critical) {
      recommendations.push({
        type: 'stop',
        priority: 1,
        message:
          'CRITICAL: Cash-out success rate is critically low. Stop betting immediately and investigate execution pipeline.',
        rationale: `Cash-out success rate is ${(input.cashOutSuccess.successRate * 100).toFixed(1)}%, below critical threshold of ${(CASHOUT_SUCCESS_THRESHOLDS.critical * 100).toFixed(1)}%. Failed cash-outs result in full stake loss regardless of round outcome.`,
        triggeredBy: ['cashout_success_rate_critical'],
        confidence: 0.95,
        triggeredAt: timestamp,
        window: input.window,
      });
      triggeredBy.push('cashout_success_rate_critical');
    } else if (input.cashOutSuccess.successRate < CASHOUT_SUCCESS_THRESHOLDS.poor) {
      recommendations.push({
        type: 'pause',
        priority: 2,
        message:
          'Cash-out success rate is poor. Pause betting and review execution latency and reliability.',
        rationale: `Cash-out success rate is ${(input.cashOutSuccess.successRate * 100).toFixed(1)}%, below acceptable threshold of ${(CASHOUT_SUCCESS_THRESHOLDS.acceptable * 100).toFixed(1)}%. Each failed cash-out costs the full stake.`,
        triggeredBy: ['cashout_success_rate_poor'],
        confidence: 0.85,
        triggeredAt: timestamp,
        window: input.window,
      });
      triggeredBy.push('cashout_success_rate_poor');
    }
  }

  // Rule 2: Hit rate significantly below break-even with negative P&L
  // This is the core profitability rule
  if (
    input.hitRate.sampleSize >= config.minSamplesForRecommendation &&
    input.hitRate.statisticalSignificance === 'significant_below' &&
    input.expectedValue.cumulativeRealizedPnl < 0
  ) {
    recommendations.push({
      type: 'dry_run',
      priority: 3,
      message:
        'Hit rate is statistically significantly below break-even with negative realized P&L. Switch to dry-run mode.',
      rationale: `Observed hit rate ${(input.hitRate.observedRate * 100).toFixed(1)}% is below break-even ${(input.hitRate.breakEvenRate * 100).toFixed(1)}% with 95% confidence. Realized P&L is ${input.expectedValue.cumulativeRealizedPnl.toFixed(2)}. Do not increase stake or target.`,
      triggeredBy: ['hit_rate_below_break_even', 'negative_pnl'],
      confidence: 0.9,
      triggeredAt: timestamp,
      window: input.window,
    });
    triggeredBy.push('hit_rate_below_break_even');
  } else if (
    input.hitRate.sampleSize >= config.minSamplesForRecommendation &&
    input.hitRate.observedRate < input.hitRate.breakEvenRate - config.pauseThresholdHitRateDelta &&
    input.expectedValue.cumulativeRealizedPnl < 0
  ) {
    // Hit rate is below break-even but not statistically significant yet
    recommendations.push({
      type: 'pause',
      priority: 4,
      message:
        'Hit rate is below break-even with negative P&L. Consider pausing to observe more rounds before continuing.',
      rationale: `Observed hit rate ${(input.hitRate.observedRate * 100).toFixed(1)}% is below break-even ${(input.hitRate.breakEvenRate * 100).toFixed(1)}%. Sample size ${input.hitRate.sampleSize} may be insufficient for statistical significance. Realized P&L is ${input.expectedValue.cumulativeRealizedPnl.toFixed(2)}.`,
      triggeredBy: ['hit_rate_below_break_even', 'negative_pnl'],
      confidence: 0.7,
      triggeredAt: timestamp,
      window: input.window,
    });
    triggeredBy.push('hit_rate_below_break_even');
  }

  // Rule 3: Maximum drawdown exceeds threshold
  // Use absolute drawdown relative to stake as a proxy for bankroll percentage
  const drawdownPercentOfStake =
    input.drawdown.maxDrawdown / (DEFAULT_STAKE * 10); // Assume 10x stake bankroll

  if (drawdownPercentOfStake > config.stopThresholdDrawdownPercent) {
    recommendations.push({
      type: 'stop',
      priority: 2,
      message: `Max drawdown of ${input.drawdown.maxDrawdown.toFixed(2)} exceeds ${(config.stopThresholdDrawdownPercent * 100).toFixed(0)}% of estimated bankroll. Stop for the day.`,
      rationale: `Maximum drawdown is ${input.drawdown.maxDrawdown.toFixed(2)} units. This represents a significant portion of the bankroll. Continuing risks further losses. Do not increase stake to recover.`,
      triggeredBy: ['max_drawdown_exceeded'],
      confidence: 0.85,
      triggeredAt: timestamp,
      window: input.window,
    });
    triggeredBy.push('max_drawdown_exceeded');
  } else if (input.drawdown.drawdownSeverity === 'severe' || input.drawdown.drawdownSeverity === 'critical') {
    recommendations.push({
      type: 'pause',
      priority: 3,
      message: `Drawdown severity is ${input.drawdown.drawdownSeverity}. Pause betting and reassess.`,
      rationale: `Current drawdown severity is ${input.drawdown.drawdownSeverity} with max drawdown of ${input.drawdown.maxDrawdown.toFixed(2)} units.`,
      triggeredBy: ['drawdown_severe'],
      confidence: 0.8,
      triggeredAt: timestamp,
      window: input.window,
    });
    triggeredBy.push('drawdown_severe');
  }

  // Rule 4: Anomalous losing streak
  if (
    input.streaks.currentLossStreak >= config.dryRunThresholdConsecutiveLosses &&
    input.streaks.streakAnomalyScore > 1.5
  ) {
    recommendations.push({
      type: 'dry_run',
      priority: 4,
      message: `Current losing streak of ${input.streaks.currentLossStreak} is anomalous. Switch to dry-run mode.`,
      rationale: `Current loss streak (${input.streaks.currentLossStreak}) exceeds expected maximum (${input.streaks.expectedMaxLossStreak.toFixed(1)}). Streak anomaly score: ${input.streaks.streakAnomalyScore.toFixed(2)}.`,
      triggeredBy: ['anomalous_losing_streak'],
      confidence: 0.75,
      triggeredAt: timestamp,
      window: input.window,
    });
    triggeredBy.push('anomalous_losing_streak');
  }

  // Rule 5: Low balance
  if (input.currentBalance !== undefined && input.currentBalance < DEFAULT_STAKE * 10) {
    recommendations.push({
      type: 'reduce_exposure',
      priority: 5,
      message: `Balance (${input.currentBalance.toFixed(2)}) is low relative to stake (${DEFAULT_STAKE}). Consider reducing exposure or stopping.`,
      rationale: `Current balance is less than 10x the stake amount. This leaves insufficient buffer for variance. Do not increase stake.`,
      triggeredBy: ['low_balance'],
      confidence: 0.8,
      triggeredAt: timestamp,
      window: input.window,
    });
    triggeredBy.push('low_balance');
  }

  // Rule 6: Observation confidence degraded
  if (input.observationConfidence && input.observationConfidence !== 'high') {
    recommendations.push({
      type: 'review',
      priority: 2,
      message: `Observation confidence is ${input.observationConfidence}. Review game adapter and observation pipeline before continuing.`,
      rationale: `Low observation confidence increases the risk of placing bets based on stale or incorrect data. This can lead to mistimed entries and exits.`,
      triggeredBy: ['observation_confidence_low'],
      confidence: 0.9,
      triggeredAt: timestamp,
      window: input.window,
    });
    triggeredBy.push('observation_confidence_low');
  }

  // Rule 7: Consecutive errors
  if (input.consecutiveErrors && input.consecutiveErrors >= 3) {
    recommendations.push({
      type: 'pause',
      priority: 2,
      message: `${input.consecutiveErrors} consecutive errors detected. Pause betting and investigate.`,
      rationale: `Multiple consecutive errors indicate system instability. Continuing may result in further failed bets or incorrect state.`,
      triggeredBy: ['consecutive_errors'],
      confidence: 0.85,
      triggeredAt: timestamp,
      window: input.window,
    });
    triggeredBy.push('consecutive_errors');
  }

  // Rule 8: EV accuracy is very poor (realized far below expected)
  // This suggests the theoretical model is not matching reality
  if (
    input.expectedValue.evAccuracy > 0 &&
    input.expectedValue.evAccuracy < 0.5 &&
    input.hitRate.sampleSize >= 50
  ) {
    recommendations.push({
      type: 'review',
      priority: 4,
      message: 'Realized P&L is significantly below theoretical expectation. Review execution quality and latency.',
      rationale: `EV accuracy is ${(input.expectedValue.evAccuracy * 100).toFixed(1)}%. Theoretical expected P&L is ${input.expectedValue.cumulativeExpectedPnl.toFixed(2)} but realized is ${input.expectedValue.cumulativeRealizedPnl.toFixed(2)}. This gap suggests execution issues (failed cash-outs, latency) rather than random variance.`,
      triggeredBy: ['ev_accuracy_poor'],
      confidence: 0.75,
      triggeredAt: timestamp,
      window: input.window,
    });
    triggeredBy.push('ev_accuracy_poor');
  }

  // Default recommendation: continue if no issues flagged
  if (recommendations.length === 0) {
    recommendations.push({
      type: 'continue',
      priority: 10,
      message: 'All metrics within normal ranges. Continue current policy.',
      rationale: `Hit rate ${(input.hitRate.observedRate * 100).toFixed(1)}% is ${input.hitRate.isAboveBreakEven ? 'above' : 'near'} break-even ${(input.hitRate.breakEvenRate * 100).toFixed(1)}%. Drawdown is ${input.drawdown.drawdownSeverity}. No anomalies detected.`,
      triggeredBy: ['all_metrics_normal'],
      confidence: 0.6,
      triggeredAt: timestamp,
      window: input.window,
    });
  }

  // Sort by priority (lower number = higher priority)
  recommendations.sort((a, b) => a.priority - b.priority);

  // Limit to max recommendations per window
  return recommendations.slice(0, config.maxRecommendationsPerWindow);
}

/**
 * Get the most severe recommendation from a list.
 */
export function getMostSevereRecommendation(
  recommendations: Recommendation[]
): Recommendation | null {
  if (recommendations.length === 0) return null;

  const severityOrder: RecommendationType[] = [
    'stop',
    'dry_run',
    'pause',
    'reduce_exposure',
    'review',
    'continue',
  ];

  return recommendations.reduce((mostSevere, rec) => {
    const currentIndex = severityOrder.indexOf(rec.type);
    const mostSevereIndex = severityOrder.indexOf(mostSevere.type);
    return currentIndex < mostSevereIndex ? rec : mostSevere;
  });
}

/**
 * Check if any recommendation is of a specific type or more severe.
 */
export function hasRecommendationOfSeverityOrWorse(
  recommendations: Recommendation[],
  minSeverity: RecommendationType
): boolean {
  const severityOrder: RecommendationType[] = [
    'stop',
    'dry_run',
    'pause',
    'reduce_exposure',
    'review',
    'continue',
  ];

  const minIndex = severityOrder.indexOf(minSeverity);

  return recommendations.some((rec) => severityOrder.indexOf(rec.type) <= minIndex);
}

/**
 * Format recommendations for human-readable display.
 */
export function formatRecommendations(recommendations: Recommendation[]): string {
  if (recommendations.length === 0) {
    return 'No recommendations available.';
  }

  const lines: string[] = [];

  for (const rec of recommendations) {
    const emoji =
      rec.type === 'stop'
        ? '🛑'
        : rec.type === 'dry_run'
          ? '🧪'
          : rec.type === 'pause'
            ? '⏸️'
            : rec.type === 'reduce_exposure'
              ? '⚠️'
              : rec.type === 'review'
                ? '🔍'
                : '✅';

    lines.push(
      `${emoji} **${rec.type.toUpperCase()}** (priority ${rec.priority})`,
      `   ${rec.message}`,
      `   Rationale: ${rec.rationale}`,
      ''
    );
  }

  return lines.join('\n');
}
