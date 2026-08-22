/**
 * Learning Curve Report — Progressive Performance Tracking Over Time
 *
 * Tracks how performance evolves as more data is collected.
 * Generates trend analysis, convergence estimates, and recommendations.
 */

import {
  LearningCurveReport,
  LearningCurvePoint,
  BetOutcomeRecord,
} from '../types';
import { computeHitRateMetrics } from '../metrics/hit-rate';
import { computeDrawdownFromOutcomes } from '../metrics/drawdown';
import { computeExpectedValueMetrics } from '../metrics/expected-value';
import { generateRecommendations } from '../learning/recommendations';
import { DEFAULT_STAKE, DEFAULT_TARGET, LEARNING_CURVE_MIN_POINTS, LEARNING_CURVE_WINDOW_STEP } from '../constants';

export interface LearningCurveInput {
  outcomes: BetOutcomeRecord[];
  windowStep?: number;
}

/**
 * Generate a learning curve report from chronological bet outcomes.
 *
 * Computes metrics at progressively larger sample sizes to show
 * how estimates converge as more data is collected.
 *
 * @param input — learning curve input data
 * @returns LearningCurveReport with trend analysis
 */
export function generateLearningCurveReport(input: LearningCurveInput): LearningCurveReport {
  const { outcomes, windowStep = LEARNING_CURVE_WINDOW_STEP } = input;

  if (outcomes.length < LEARNING_CURVE_MIN_POINTS) {
    return {
      points: [],
      trendDirection: 'stable',
      trendStrength: 0,
      convergenceEstimate: null,
      recommendations: [],
      generatedAt: new Date().toISOString(),
    };
  }

  const points: LearningCurvePoint[] = [];

  // Generate points at increasing window sizes
  for (let n = windowStep; n <= outcomes.length; n += windowStep) {
    const window = outcomes.slice(0, n);
    const hitRate = computeHitRateMetrics(window, DEFAULT_TARGET);
    const drawdown = computeDrawdownFromOutcomes(window);
    const ev = computeExpectedValueMetrics(window, DEFAULT_STAKE, DEFAULT_TARGET);

    const lastOutcome = window[window.length - 1];

    points.push({
      timestamp: lastOutcome.timestamp,
      windowType: 'all',
      cumulativeEntries: n,
      hitRate: hitRate.observedRate,
      confidenceLower: hitRate.confidenceInterval.lower,
      confidenceUpper: hitRate.confidenceInterval.upper,
      netPnl: ev.cumulativeRealizedPnl,
      maxDrawdown: drawdown.maxDrawdown,
      evPerEntry: ev.realizedEvPerEntry,
    });
  }

  // Add final point if not already included
  const lastN = points.length > 0 ? points[points.length - 1].cumulativeEntries : 0;
  if (lastN < outcomes.length) {
    const window = outcomes;
    const hitRate = computeHitRateMetrics(window, DEFAULT_TARGET);
    const drawdown = computeDrawdownFromOutcomes(window);
    const ev = computeExpectedValueMetrics(window, DEFAULT_STAKE, DEFAULT_TARGET);
    const lastOutcome = window[window.length - 1];

    points.push({
      timestamp: lastOutcome.timestamp,
      windowType: 'all',
      cumulativeEntries: outcomes.length,
      hitRate: hitRate.observedRate,
      confidenceLower: hitRate.confidenceInterval.lower,
      confidenceUpper: hitRate.confidenceInterval.upper,
      netPnl: ev.cumulativeRealizedPnl,
      maxDrawdown: drawdown.maxDrawdown,
      evPerEntry: ev.realizedEvPerEntry,
    });
  }

  const trend = analyzeTrend(points);
  const convergenceEstimate = estimateConvergence(points);

  // Generate recommendations based on latest point
  const latestWindow = outcomes;
  const hitRate = computeHitRateMetrics(latestWindow, DEFAULT_TARGET);
  const drawdown = computeDrawdownFromOutcomes(latestWindow);
  const ev = computeExpectedValueMetrics(latestWindow, DEFAULT_STAKE, DEFAULT_TARGET);

  const recInput = {
    hitRate,
    drawdown,
    streaks: { currentWinStreak: 0, currentLossStreak: 0, maxWinStreak: 0, maxLossStreak: 0, currentStreakType: 'none' as const, winStreakDistribution: [], lossStreakDistribution: [], expectedMaxWinStreak: 0, expectedMaxLossStreak: 0, streakAnomalyScore: 0 },
    cashOutSuccess: { successRate: 1, failureRate: 0, totalAttempts: 0, successfulCashouts: 0, failedCashouts: 0, timeoutCount: 0, prematureCrashCount: 0, errorCount: 0, trendDirection: 'stable' as const, failureModeBreakdown: {} },
    expectedValue: ev,
    window: 'all' as const,
  };

  const recommendations = generateRecommendations(recInput);

  return {
    points,
    trendDirection: trend.direction,
    trendStrength: trend.strength,
    convergenceEstimate,
    recommendations,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Analyze the trend direction and strength from learning curve points.
 */
function analyzeTrend(points: LearningCurvePoint[]): { direction: 'improving' | 'stable' | 'declining'; strength: number } {
  if (points.length < 3) {
    return { direction: 'stable', strength: 0 };
  }

  // Use linear regression on hit rate to determine trend
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    const x = i;
    const y = points[i].hitRate;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) {
    return { direction: 'stable', strength: 0 };
  }

  const slope = (n * sumXY - sumX * sumY) / denominator;

  // Normalize slope to strength (0-1)
  const maxExpectedSlope = 0.01; // 1% per step is a strong trend
  const strength = Math.min(1, Math.abs(slope) / maxExpectedSlope);

  let direction: 'improving' | 'stable' | 'declining';
  if (strength < 0.2) {
    direction = 'stable';
  } else if (slope > 0) {
    direction = 'improving';
  } else {
    direction = 'declining';
  }

  return { direction, strength };
}

/**
 * Estimate how many more samples are needed for the hit rate
 * confidence interval to narrow to a target width.
 */
function estimateConvergence(points: LearningCurvePoint[]): number | null {
  if (points.length < 3) return null;

  const latest = points[points.length - 1];
  const targetWidth = 0.05; // Target CI width of 5%
  const currentWidth = latest.confidenceUpper - latest.confidenceLower;

  if (currentWidth <= targetWidth) {
    return 0; // Already converged
  }

  // CI width is approximately proportional to 1/sqrt(n)
  // n_target = n_current * (current_width / target_width)^2
  const currentN = latest.cumulativeEntries;
  const estimatedN = currentN * Math.pow(currentWidth / targetWidth, 2);

  return Math.ceil(estimatedN - currentN);
}

/**
 * Format a learning curve report for Telegram display.
 */
export function formatLearningCurveReport(report: LearningCurveReport): string {
  if (report.points.length === 0) {
    return '📈 *Learning Curve*\n\nInsufficient data (minimum 5 entries required).';
  }

  const latest = report.points[report.points.length - 1];
  const trendEmoji = report.trendDirection === 'improving' ? '📈' : report.trendDirection === 'declining' ? '📉' : '➡️';

  const lines = [
    `📈 *Learning Curve*`,
    '',
    `*Trend:* ${trendEmoji} ${report.trendDirection} (strength: ${(report.trendStrength * 100).toFixed(0)}%)`,
    `*Total Entries:* ${latest.cumulativeEntries}`,
    `*Current Hit Rate:* ${(latest.hitRate * 100).toFixed(1)}%`,
    `*95% CI:* [${(latest.confidenceLower * 100).toFixed(1)}%, ${(latest.confidenceUpper * 100).toFixed(1)}%]`,
    `*Net P&L:* ${latest.netPnl.toFixed(2)}`,
    `*Max Drawdown:* ${latest.maxDrawdown.toFixed(2)}`,
    `*EV/Entry:* ${latest.evPerEntry.toFixed(2)}`,
  ];

  if (report.convergenceEstimate !== null) {
    if (report.convergenceEstimate === 0) {
      lines.push('*Convergence:* ✅ CI width is within target');
    } else {
      lines.push(`*Convergence:* ~${report.convergenceEstimate} more entries needed for tight CI`);
    }
  }

  if (report.recommendations.length > 0) {
    lines.push('', '*Recommendations:*');
    for (const rec of report.recommendations.slice(0, 2)) {
      const emoji = rec.type === 'stop' ? '🛑' : rec.type === 'pause' ? '⏸️' : rec.type === 'dry_run' ? '🧪' : '✅';
      lines.push(`${emoji} ${rec.message}`);
    }
  }

  return lines.join('\n');
}
