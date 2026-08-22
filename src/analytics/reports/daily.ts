/**
 * Daily Report — End-of-Day Aggregated Performance Report
 *
 * Generates a comprehensive daily report including entries, hit rate,
 * P&L, drawdown, cash-out success rate, recommendations, and anomalies.
 */

import {
  DailyReport,
  BetOutcomeRecord,
  LatencySample,
} from '../types';
import { computeHitRateMetrics } from '../metrics/hit-rate';
import { computeDrawdownFromOutcomes } from '../metrics/drawdown';
import { computeCashOutSuccessMetrics } from '../metrics/cashout-success';
import { computeExpectedValueMetrics } from '../metrics/expected-value';
import { computeLatencyMetrics } from '../metrics/latency';
import { generateRecommendations } from '../learning/recommendations';
import { detectAnomalies } from '../learning/anomaly';
import { DEFAULT_STAKE, DEFAULT_TARGET } from '../constants';

export interface DailyReportInput {
  dailyKey: string;
  outcomes: BetOutcomeRecord[];
  latencySamples: LatencySample[];
  balanceStart: number | null;
  balanceEnd: number | null;
  currentBalance?: number;
  observationConfidence?: 'high' | 'medium' | 'low';
}

/**
 * Generate a daily report from the day's bet outcomes.
 *
 * @param input — daily report input data
 * @returns DailyReport with full analysis
 */
export function generateDailyReport(input: DailyReportInput): DailyReport {
  const { dailyKey, outcomes, latencySamples } = input;

  const resolved = outcomes.filter((o) => o.outcome === 'win' || o.outcome === 'loss');
  const wins = resolved.filter((o) => o.outcome === 'win').length;
  const losses = resolved.filter((o) => o.outcome === 'loss').length;
  const entriesConfirmed = resolved.length;
  const entriesAttempted = outcomes.length;
  const entriesFailed = outcomes.filter((o) => o.outcome === 'failed').length;

  const netPnl = resolved.reduce((sum, o) => sum + o.pnl, 0);

  const hitRate = computeHitRateMetrics(outcomes, DEFAULT_TARGET);
  const drawdown = computeDrawdownFromOutcomes(outcomes);
  const cashOutSuccess = computeCashOutSuccessMetrics(outcomes);
  const expectedValue = computeExpectedValueMetrics(outcomes, DEFAULT_STAKE, DEFAULT_TARGET);
  const latency = computeLatencyMetrics(latencySamples);

  // Generate recommendations
  const recInput = {
    hitRate,
    drawdown,
    streaks: { currentWinStreak: 0, currentLossStreak: 0, maxWinStreak: 0, maxLossStreak: 0, currentStreakType: 'none' as const, winStreakDistribution: [], lossStreakDistribution: [], expectedMaxWinStreak: 0, expectedMaxLossStreak: 0, streakAnomalyScore: 0 },
    cashOutSuccess,
    expectedValue,
    window: 'day' as const,
    currentBalance: input.currentBalance,
    observationConfidence: input.observationConfidence,
  };

  const recommendations = generateRecommendations(recInput);

  // Detect anomalies
  const anomalyInput = {
    outcomes,
    hitRate,
    drawdown,
    streaks: recInput.streaks,
    latency,
    cashOutSuccess,
    window: 'day' as const,
    observationConfidence: input.observationConfidence,
  };

  const anomalies = detectAnomalies(anomalyInput);

  return {
    dailyKey,
    entriesConfirmed,
    entriesAttempted,
    entriesFailed,
    wins,
    losses,
    hitRate,
    netPnl,
    expectedPnl: expectedValue.cumulativeExpectedPnl,
    maxDrawdown: drawdown.maxDrawdown,
    currentDrawdown: drawdown.currentDrawdown,
    cashOutSuccessRate: cashOutSuccess.successRate,
    averageLatencyMs: latency.p50,
    recommendations,
    anomalies,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Format a daily report for Telegram display.
 */
export function formatDailyReport(report: DailyReport): string {
  const ci = report.hitRate.confidenceInterval;
  const pnlEmoji = report.netPnl >= 0 ? '🟢' : '🔴';
  const ddSeverity = report.currentDrawdown > report.maxDrawdown * 0.8 ? '🔴' : '🟢';

  const lines = [
    `📅 *Daily Report — ${report.dailyKey}*`,
    '',
    `*Entries:* ${report.entriesConfirmed} confirmed / ${report.entriesAttempted} attempted / ${report.entriesFailed} failed`,
    `*Wins/Losses:* ${report.wins}W / ${report.losses}L`,
    `*Hit Rate:* ${(report.hitRate.observedRate * 100).toFixed(1)}% (break-even: ${(report.hitRate.breakEvenRate * 100).toFixed(1)}%)`,
    `*95% CI:* [${(ci.lower * 100).toFixed(1)}%, ${(ci.upper * 100).toFixed(1)}%]`,
    `*Net P&L:* ${pnlEmoji} ${report.netPnl.toFixed(2)}`,
    `*Expected P&L:* ${report.expectedPnl.toFixed(2)}`,
    `*Max Drawdown:* ${report.maxDrawdown.toFixed(2)}`,
    `*Current Drawdown:* ${ddSeverity} ${report.currentDrawdown.toFixed(2)}`,
    `*Cash-Out Success:* ${(report.cashOutSuccessRate * 100).toFixed(1)}%`,
    `*Avg Latency:* ${report.averageLatencyMs.toFixed(0)}ms`,
  ];

  if (report.anomalies.length > 0) {
    lines.push('', `*Anomalies:* ${report.anomalies.length} flagged`);
    for (const anomaly of report.anomalies.slice(0, 3)) {
      const emoji = anomaly.severity === 'critical' ? '🔴' : '🟡';
      lines.push(`${emoji} ${anomaly.message}`);
    }
  }

  if (report.recommendations.length > 0) {
    lines.push('', '*Recommendations:*');
    for (const rec of report.recommendations.slice(0, 3)) {
      const emoji = rec.type === 'stop' ? '🛑' : rec.type === 'pause' ? '⏸️' : rec.type === 'dry_run' ? '🧪' : '✅';
      lines.push(`${emoji} ${rec.message}`);
    }
  }

  return lines.join('\n');
}
