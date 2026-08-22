/**
 * Analytics Engine — Central Orchestrator for Metrics, Learning & Reports
 *
 * The Analytics Engine is descriptive and evaluative only.
 * It does NOT generate predictions, does NOT claim future profitability,
 * and does NOT auto-adjust stake or target.
 *
 * Responsibilities:
 * - Aggregate metrics across all windows
 * - Generate reports (daily, session, learning curve)
 * - Detect anomalies and generate recommendations
 * - Expose analytics data to Telegram commands
 * - Maintain in-memory state for real-time queries
 */

import {
  AnalyticsEngineConfig,
  MetricSnapshot,
  WindowType,
  BetOutcomeRecord,
  LatencySample,
  RoundObservationRecord,
  DailyReport,
  SessionReport,
  LearningCurveReport,
  AnalyticsSummary,
  TelegramAnalyticsPayload,
} from './types';
import {
  DEFAULT_TARGET,
  WINDOW_CONFIGS,
} from './constants';
import { aggregateWindow, aggregateAllWindows, formatMetricSnapshot } from './windows';
import { generateDailyReport } from './reports/daily';
import { generateSessionReport } from './reports/session';
import { generateLearningCurveReport } from './reports/learning-curve';

export interface AnalyticsEngineState {
  outcomes: BetOutcomeRecord[];
  latencySamples: LatencySample[];
  rounds: RoundObservationRecord[];
  sessionId: string | null;
  sessionStartTime: string | null;
  currentBalance: number | null;
  observationConfidence: 'high' | 'medium' | 'low';
  lastDailyReportKey: string | null;
  lastDailyReport: DailyReport | null;
}

export class AnalyticsEngine {
  private state: AnalyticsEngineState;

  constructor(_config?: Partial<AnalyticsEngineConfig>) {
    void _config; // reserved for future configurable thresholds

    this.state = {
      outcomes: [],
      latencySamples: [],
      rounds: [],
      sessionId: null,
      sessionStartTime: null,
      currentBalance: null,
      observationConfidence: 'high',
      lastDailyReportKey: null,
      lastDailyReport: null,
    };
  }

  // ─── State Management ──────────────────────────────────────────────────────

  /**
   * Record a bet outcome.
   */
  recordOutcome(outcome: BetOutcomeRecord): void {
    this.state.outcomes.push(outcome);
  }

  /**
   * Record multiple bet outcomes.
   */
  recordOutcomes(outcomes: BetOutcomeRecord[]): void {
    this.state.outcomes.push(...outcomes);
  }

  /**
   * Record a latency sample.
   */
  recordLatency(sample: LatencySample): void {
    this.state.latencySamples.push(sample);
  }

  /**
   * Record multiple latency samples.
   */
  recordLatencies(samples: LatencySample[]): void {
    this.state.latencySamples.push(...samples);
  }

  /**
   * Record a round observation.
   */
  recordRound(round: RoundObservationRecord): void {
    this.state.rounds.push(round);
  }

  /**
   * Record multiple round observations.
   */
  recordRounds(rounds: RoundObservationRecord[]): void {
    this.state.rounds.push(...rounds);
  }

  /**
   * Set the current balance.
   */
  setBalance(balance: number): void {
    this.state.currentBalance = balance;
  }

  /**
   * Set observation confidence level.
   */
  setObservationConfidence(confidence: 'high' | 'medium' | 'low'): void {
    this.state.observationConfidence = confidence;
  }

  /**
   * Start a new session.
   */
  startSession(sessionId: string): void {
    this.state.sessionId = sessionId;
    this.state.sessionStartTime = new Date().toISOString();
  }

  /**
   * End the current session.
   */
  endSession(): void {
    this.state.sessionId = null;
    this.state.sessionStartTime = null;
  }

  /**
   * Get the current engine state.
   */
  getState(): AnalyticsEngineState {
    return { ...this.state };
  }

  /**
   * Clear all data (use with caution).
   */
  clear(): void {
    this.state.outcomes = [];
    this.state.latencySamples = [];
    this.state.rounds = [];
    this.state.sessionId = null;
    this.state.sessionStartTime = null;
    this.state.currentBalance = null;
    this.state.observationConfidence = 'high';
    this.state.lastDailyReportKey = null;
    this.state.lastDailyReport = null;
  }

  // ─── Metric Queries ────────────────────────────────────────────────────────

  /**
   * Get a metric snapshot for a specific window.
   */
  getSnapshot(window: WindowType): MetricSnapshot | null {
    return aggregateWindow({
      outcomes: this.state.outcomes,
      latencySamples: this.state.latencySamples,
      rounds: this.state.rounds,
      window,
      currentBalance: this.state.currentBalance ?? undefined,
      observationConfidence: this.state.observationConfidence,
      sessionStartTime: this.state.sessionStartTime ?? undefined,
    });
  }

  /**
   * Get metric snapshots for all windows.
   */
  getAllSnapshots(): Record<WindowType, MetricSnapshot | null> {
    return aggregateAllWindows({
      outcomes: this.state.outcomes,
      latencySamples: this.state.latencySamples,
      rounds: this.state.rounds,
      currentBalance: this.state.currentBalance ?? undefined,
      observationConfidence: this.state.observationConfidence,
      sessionStartTime: this.state.sessionStartTime ?? undefined,
    });
  }

  /**
   * Get a quick summary for a window.
   */
  getSummary(window: WindowType): AnalyticsSummary | null {
    const snapshot = this.getSnapshot(window);
    if (!snapshot) return null;

    return {
      window,
      windowSize: snapshot.hitRate.sampleSize,
      entries: snapshot.hitRate.sampleSize,
      wins: Math.round(snapshot.hitRate.sampleSize * snapshot.hitRate.observedRate),
      losses: snapshot.hitRate.sampleSize - Math.round(snapshot.hitRate.sampleSize * snapshot.hitRate.observedRate),
      hitRate: snapshot.hitRate.observedRate,
      breakEvenHitRate: snapshot.hitRate.breakEvenRate,
      realizedPnl: snapshot.expectedValue.cumulativeRealizedPnl,
      expectedPnl: snapshot.expectedValue.cumulativeExpectedPnl,
      maxDrawdown: snapshot.drawdown.maxDrawdown,
      currentDrawdown: snapshot.drawdown.currentDrawdown,
      recommendation: snapshot.recommendations[0]?.type || 'continue',
    };
  }

  // ─── Report Generation ─────────────────────────────────────────────────────

  /**
   * Generate a daily report for the current day.
   */
  generateDailyReport(): DailyReport {
    const dailyKey = getDailyKey();
    const dayOutcomes = this.state.outcomes.filter((o) => o.dailyKey === dailyKey);
    const dayLatency = this.state.latencySamples.filter((s) => {
      const sDate = new Date(s.timestamp);
      const now = new Date();
      return (
        sDate.getUTCFullYear() === now.getUTCFullYear() &&
        sDate.getUTCMonth() === now.getUTCMonth() &&
        sDate.getUTCDate() === now.getUTCDate()
      );
    });

    const report = generateDailyReport({
      dailyKey,
      outcomes: dayOutcomes,
      latencySamples: dayLatency,
      balanceStart: null,
      balanceEnd: this.state.currentBalance,
      currentBalance: this.state.currentBalance ?? undefined,
      observationConfidence: this.state.observationConfidence,
    });

    this.state.lastDailyReportKey = dailyKey;
    this.state.lastDailyReport = report;

    return report;
  }

  /**
   * Generate a session report.
   */
  generateSessionReport(): SessionReport | null {
    if (!this.state.sessionId || !this.state.sessionStartTime) {
      return null;
    }

    return generateSessionReport({
      sessionId: this.state.sessionId,
      startedAt: this.state.sessionStartTime,
      endedAt: new Date().toISOString(),
      outcomes: this.state.outcomes,
      latencySamples: this.state.latencySamples,
      currentBalance: this.state.currentBalance ?? undefined,
      observationConfidence: this.state.observationConfidence,
    });
  }

  /**
   * Generate a learning curve report.
   */
  generateLearningCurveReport(): LearningCurveReport {
    return generateLearningCurveReport({
      outcomes: this.state.outcomes,
    });
  }

  // ─── Telegram Command Handlers ─────────────────────────────────────────────

  /**
   * Handle `/analytics summary` command.
   */
  handleSummaryCommand(): TelegramAnalyticsPayload {
    const snapshot = this.getSnapshot('last_100') || this.getSnapshot('last_50') || this.getSnapshot('last_10');
    const summary = this.getSummary('last_100') || this.getSummary('last_50') || this.getSummary('last_10');

    if (!snapshot || !summary) {
      return {
        command: '/analytics summary',
        summary: this.emptySummary(),
        hitRateDetails: null,
        drawdownDetails: null,
        streakDetails: null,
        evDetails: null,
        recommendations: [],
        anomalies: [],
        formattedMessage: '⚠️ No data available yet. Place some bets first.',
      };
    }

    return {
      command: '/analytics summary',
      summary,
      hitRateDetails: snapshot.hitRate,
      drawdownDetails: snapshot.drawdown,
      streakDetails: snapshot.streaks,
      evDetails: snapshot.expectedValue,
      recommendations: snapshot.recommendations,
      anomalies: snapshot.anomalies,
      formattedMessage: formatMetricSnapshot(snapshot),
    };
  }

  /**
   * Handle `/analytics today` command.
   */
  handleTodayCommand(): TelegramAnalyticsPayload {
    const snapshot = this.getSnapshot('day');
    const summary = this.getSummary('day');

    if (!snapshot || !summary) {
      return {
        command: '/analytics today',
        summary: this.emptySummary(),
        hitRateDetails: null,
        drawdownDetails: null,
        streakDetails: null,
        evDetails: null,
        recommendations: [],
        anomalies: [],
        formattedMessage: '⚠️ No data for today yet.',
      };
    }

    return {
      command: '/analytics today',
      summary,
      hitRateDetails: snapshot.hitRate,
      drawdownDetails: snapshot.drawdown,
      streakDetails: snapshot.streaks,
      evDetails: snapshot.expectedValue,
      recommendations: snapshot.recommendations,
      anomalies: snapshot.anomalies,
      formattedMessage: formatMetricSnapshot(snapshot),
    };
  }

  /**
   * Handle `/analytics <window>` command.
   */
  handleWindowCommand(window: WindowType): TelegramAnalyticsPayload {
    const snapshot = this.getSnapshot(window);
    const summary = this.getSummary(window);

    if (!snapshot || !summary) {
      const config = WINDOW_CONFIGS.find((w) => w.type === window);
      return {
        command: `/analytics ${window}`,
        summary: this.emptySummary(),
        hitRateDetails: null,
        drawdownDetails: null,
        streakDetails: null,
        evDetails: null,
        recommendations: [],
        anomalies: [],
        formattedMessage: `⚠️ Insufficient data for ${config?.label || window}. Need at least ${config?.minSamples || 10} resolved entries.`,
      };
    }

    return {
      command: `/analytics ${window}`,
      summary,
      hitRateDetails: snapshot.hitRate,
      drawdownDetails: snapshot.drawdown,
      streakDetails: snapshot.streaks,
      evDetails: snapshot.expectedValue,
      recommendations: snapshot.recommendations,
      anomalies: snapshot.anomalies,
      formattedMessage: formatMetricSnapshot(snapshot),
    };
  }

  /**
   * Handle `/analytics drawdown` command.
   */
  handleDrawdownCommand(): TelegramAnalyticsPayload {
    const snapshot = this.getSnapshot('all') || this.getSnapshot('last_500') || this.getSnapshot('last_100');

    if (!snapshot) {
      return {
        command: '/analytics drawdown',
        summary: this.emptySummary(),
        hitRateDetails: null,
        drawdownDetails: null,
        streakDetails: null,
        evDetails: null,
        recommendations: [],
        anomalies: [],
        formattedMessage: '⚠️ No data available for drawdown analysis.',
      };
    }

    const dd = snapshot.drawdown;
    const lines = [
      '📉 *Drawdown Analysis*',
      '',
      `*Max Drawdown:* ${dd.maxDrawdown.toFixed(2)}`,
      `*Current Drawdown:* ${dd.currentDrawdown.toFixed(2)}`,
      `*Peak Equity:* ${dd.peakEquity.toFixed(2)}`,
      `*Current Equity:* ${dd.currentEquity.toFixed(2)}`,
      `*Underwater:* ${dd.isUnderwater ? 'Yes 🔴' : 'No 🟢'}`,
      `*Underwater Bets:* ${dd.underwaterDuration}`,
      `*Max Underwater:* ${dd.maxUnderwaterDuration} bets`,
      `*Recoveries:* ${dd.recoveryCount}`,
      `*Severity:* ${dd.drawdownSeverity}`,
    ];

    return {
      command: '/analytics drawdown',
      summary: this.getSummary('all') || this.emptySummary(),
      hitRateDetails: snapshot.hitRate,
      drawdownDetails: dd,
      streakDetails: snapshot.streaks,
      evDetails: snapshot.expectedValue,
      recommendations: snapshot.recommendations,
      anomalies: snapshot.anomalies,
      formattedMessage: lines.join('\n'),
    };
  }

  // ─── Utility ───────────────────────────────────────────────────────────────

  private emptySummary(): AnalyticsSummary {
    return {
      window: 'all',
      windowSize: 0,
      entries: 0,
      wins: 0,
      losses: 0,
      hitRate: 0,
      breakEvenHitRate: 1 / DEFAULT_TARGET,
      realizedPnl: 0,
      expectedPnl: 0,
      maxDrawdown: 0,
      currentDrawdown: 0,
      recommendation: 'continue',
    };
  }
}

/**
 * Get the current daily key (YYYY-MM-DD).
 */
function getDailyKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Create a standalone analytics engine instance.
 */
export function createAnalyticsEngine(config?: Partial<AnalyticsEngineConfig>): AnalyticsEngine {
  return new AnalyticsEngine(config);
}
