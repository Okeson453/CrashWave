/**
 * Session Report — Lifetime Session Statistics & Health Summary
 *
 * Generates a comprehensive session-level report including lifetime stats,
 * efficiency metrics, health score, and performance analysis.
 */

import {
  SessionReport,
  BetOutcomeRecord,
  LatencySample,
  HitRateMetrics,
  DrawdownMetrics,
  LatencyMetrics,
  CashOutSuccessMetrics,
} from '../types';
import { computeHitRateMetrics } from '../metrics/hit-rate';
import { computeDrawdownFromOutcomes } from '../metrics/drawdown';
import { computeStreakMetrics } from '../metrics/streaks';
import { computeCashOutSuccessMetrics } from '../metrics/cashout-success';
import { computeLatencyMetrics } from '../metrics/latency';
import { computeExpectedValueMetrics } from '../metrics/expected-value';
import { generateRecommendations } from '../learning/recommendations';
import { detectAnomalies } from '../learning/anomaly';
import { DEFAULT_STAKE, DEFAULT_TARGET } from '../constants';

export interface SessionReportInput {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  outcomes: BetOutcomeRecord[];
  latencySamples: LatencySample[];
  currentBalance?: number;
  observationConfidence?: 'high' | 'medium' | 'low';
}

/**
 * Generate a session report from session data.
 *
 * @param input — session report input
 * @returns SessionReport with full analysis
 */
export function generateSessionReport(input: SessionReportInput): SessionReport {
  const { sessionId, startedAt, endedAt, outcomes, latencySamples } = input;

  const resolved = outcomes.filter((o) => o.outcome === 'win' || o.outcome === 'loss');
  const wins = resolved.filter((o) => o.outcome === 'win').length;
  const losses = resolved.filter((o) => o.outcome === 'loss').length;
  const entries = resolved.length;

  const netPnl = resolved.reduce((sum, o) => sum + o.pnl, 0);

  const hitRate = computeHitRateMetrics(outcomes, DEFAULT_TARGET);
  const drawdown = computeDrawdownFromOutcomes(outcomes);
  const streaks = computeStreakMetrics(outcomes, hitRate.observedRate);
  const cashOutSuccess = computeCashOutSuccessMetrics(outcomes);
  const latency = computeLatencyMetrics(latencySamples);
  const expectedValue = computeExpectedValueMetrics(outcomes, DEFAULT_STAKE, DEFAULT_TARGET);

  const recInput = {
    hitRate,
    drawdown,
    streaks,
    cashOutSuccess,
    expectedValue,
    window: 'session' as const,
    currentBalance: input.currentBalance,
    observationConfidence: input.observationConfidence,
  };

  const recommendations = generateRecommendations(recInput);

  const anomalyInput = {
    outcomes,
    hitRate,
    drawdown,
    streaks,
    latency,
    cashOutSuccess,
    window: 'session' as const,
    observationConfidence: input.observationConfidence,
  };

  const anomalies = detectAnomalies(anomalyInput);

  const durationMinutes = endedAt
    ? (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / (1000 * 60)
    : (Date.now() - new Date(startedAt).getTime()) / (1000 * 60);

  const healthScore = computeHealthScore(hitRate, drawdown, latency, cashOutSuccess);
  const efficiencyScore = computeEfficiencyScore(entries, durationMinutes, cashOutSuccess);

  return {
    sessionId,
    startedAt,
    endedAt,
    durationMinutes,
    entries,
    wins,
    losses,
    hitRate,
    netPnl,
    maxDrawdown: drawdown.maxDrawdown,
    currentDrawdown: drawdown.currentDrawdown,
    streakMetrics: streaks,
    latencyMetrics: latency,
    cashOutMetrics: cashOutSuccess,
    recommendations,
    anomalies,
    healthScore,
    efficiencyScore,
  };
}

/**
 * Compute a health score (0-100) based on key metrics.
 */
function computeHealthScore(
  hitRate: HitRateMetrics,
  drawdown: DrawdownMetrics,
  latency: LatencyMetrics,
  cashOutSuccess: CashOutSuccessMetrics
): number {
  let score = 100;

  // Hit rate penalty
  if (hitRate.observedRate < hitRate.breakEvenRate) {
    score -= 20;
  }
  if (hitRate.statisticalSignificance === 'significant_below') {
    score -= 15;
  }

  // Drawdown penalty
  if (drawdown.drawdownSeverity === 'moderate') score -= 10;
  if (drawdown.drawdownSeverity === 'severe') score -= 20;
  if (drawdown.drawdownSeverity === 'critical') score -= 30;

  // Latency penalty
  if (latency.degradationTrend === 'degrading') score -= 10;
  if (latency.degradationTrend === 'critical') score -= 20;

  // Cash-out penalty
  if (cashOutSuccess.successRate < 0.95) score -= 15;
  if (cashOutSuccess.successRate < 0.90) score -= 20;

  return Math.max(0, Math.min(100, score));
}

/**
 * Compute an efficiency score (0-100) based on entries per hour and cash-out success.
 */
function computeEfficiencyScore(
  entries: number,
  durationMinutes: number,
  cashOutSuccess: CashOutSuccessMetrics
): number {
  if (durationMinutes <= 0) return 0;

  const entriesPerHour = (entries / durationMinutes) * 60;
  let score = Math.min(50, entriesPerHour * 2); // Up to 50 points for entry rate

  // Cash-out success contributes up to 50 points
  score += cashOutSuccess.successRate * 50;

  return Math.max(0, Math.min(100, score));
}

/**
 * Format a session report for Telegram display.
 */
export function formatSessionReport(report: SessionReport): string {
  const ci = report.hitRate.confidenceInterval;
  const pnlEmoji = report.netPnl >= 0 ? '🟢' : '🔴';
  const healthEmoji = report.healthScore >= 80 ? '🟢' : report.healthScore >= 50 ? '🟡' : '🔴';

  const lines = [
    `🎮 *Session Report — ${report.sessionId}*`,
    '',
    `*Duration:* ${formatDuration(report.durationMinutes)}`,
    `*Entries:* ${report.entries} (${report.wins}W / ${report.losses}L)`,
    `*Hit Rate:* ${(report.hitRate.observedRate * 100).toFixed(1)}%`,
    `*95% CI:* [${(ci.lower * 100).toFixed(1)}%, ${(ci.upper * 100).toFixed(1)}%]`,
    `*Net P&L:* ${pnlEmoji} ${report.netPnl.toFixed(2)}`,
    `*Max Drawdown:* ${report.maxDrawdown.toFixed(2)}`,
    `*Current Drawdown:* ${report.currentDrawdown.toFixed(2)}`,
    `*Cash-Out Success:* ${(report.cashOutMetrics.successRate * 100).toFixed(1)}%`,
    `*Latency P95:* ${report.latencyMetrics.p95.toFixed(0)}ms`,
    '',
    `*Health Score:* ${healthEmoji} ${report.healthScore}/100`,
    `*Efficiency Score:* ${report.efficiencyScore}/100`,
  ];

  if (report.streakMetrics.maxWinStreak > 0 || report.streakMetrics.maxLossStreak > 0) {
    lines.push(
      '',
      `*Max Win Streak:* ${report.streakMetrics.maxWinStreak}`,
      `*Max Loss Streak:* ${report.streakMetrics.maxLossStreak}`,
      `*Current Streak:* ${report.streakMetrics.currentStreakType === 'win' ? '🔥' : '❄️'} ${report.streakMetrics.currentStreakType === 'none' ? 0 : report.streakMetrics.currentStreakType === 'win' ? report.streakMetrics.currentWinStreak : report.streakMetrics.currentLossStreak}`
    );
  }

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

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = Math.floor(minutes % 60);
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}
