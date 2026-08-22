/**
 * Rolling Window Aggregation Engine
 *
 * Aggregates bet outcomes over multiple time horizons:
 * - Numeric windows: 10, 50, 100, 500 entries
 * - Time-based windows: day, week (7d), month (30d)
 * - Special windows: session, all-time
 *
 * Each window produces a complete metric snapshot.
 */

import {
  WindowType,
  MetricSnapshot,
  BetOutcomeRecord,
  LatencySample,
  RoundObservationRecord,
} from './types';
import { computeHitRateMetrics } from './metrics/hit-rate';
import { computeDrawdownFromOutcomes } from './metrics/drawdown';
import { computeStreakMetrics } from './metrics/streaks';
import { computeExpectedValueMetrics } from './metrics/expected-value';
import { computeLatencyMetrics } from './metrics/latency';
import { computeCashOutSuccessMetrics } from './metrics/cashout-success';
import { generateRecommendations } from './learning/recommendations';
import { detectAnomalies } from './learning/anomaly';
import {
  DEFAULT_STAKE,
  DEFAULT_TARGET,
  WINDOW_CONFIGS,
  getMinSamplesForWindow,
} from './constants';

export interface WindowAggregationInput {
  outcomes: BetOutcomeRecord[];
  latencySamples: LatencySample[];
  rounds?: RoundObservationRecord[];
  window: WindowType;
  currentBalance?: number;
  observationConfidence?: 'high' | 'medium' | 'low';
  sessionStartTime?: string;
}

/**
 * Aggregate metrics for a specific window.
 *
 * @param input — window aggregation input
 * @returns MetricSnapshot for the requested window, or null if insufficient data
 */
export function aggregateWindow(input: WindowAggregationInput): MetricSnapshot | null {
  const { outcomes, latencySamples, window } = input;

  const windowOutcomes = filterOutcomesByWindow(outcomes, window, input.sessionStartTime);

  const minSamples = getMinSamplesForWindow(window);
  const resolved = windowOutcomes.filter((o) => o.outcome === 'win' || o.outcome === 'loss');

  if (resolved.length < minSamples) {
    return null;
  }

  const hitRate = computeHitRateMetrics(windowOutcomes, DEFAULT_TARGET);
  const drawdown = computeDrawdownFromOutcomes(windowOutcomes);
  const streaks = computeStreakMetrics(windowOutcomes, hitRate.observedRate);
  const expectedValue = computeExpectedValueMetrics(windowOutcomes, DEFAULT_STAKE, DEFAULT_TARGET);
  const latency = computeLatencyMetrics(
    filterLatencyByWindow(latencySamples, window, input.sessionStartTime)
  );
  const cashOutSuccess = computeCashOutSuccessMetrics(windowOutcomes);

  const recInput = {
    hitRate,
    drawdown,
    streaks,
    cashOutSuccess,
    expectedValue,
    window,
    currentBalance: input.currentBalance,
    observationConfidence: input.observationConfidence,
  };

  const recommendations = generateRecommendations(recInput);

  const anomalyInput = {
    outcomes: windowOutcomes,
    hitRate,
    drawdown,
    streaks,
    latency,
    cashOutSuccess,
    window,
    observationConfidence: input.observationConfidence,
  };

  const anomalies = detectAnomalies(anomalyInput);

  return {
    timestamp: new Date().toISOString(),
    window,
    hitRate,
    drawdown,
    streaks,
    expectedValue,
    latency,
    cashOutSuccess,
    recommendations,
    anomalies,
  };
}

/**
 * Aggregate metrics for all standard windows.
 *
 * @param input — window aggregation input (window field is ignored)
 * @returns Record mapping window type to MetricSnapshot (null if insufficient data)
 */
export function aggregateAllWindows(
  input: Omit<WindowAggregationInput, 'window'>
): Record<WindowType, MetricSnapshot | null> {
  const windows: WindowType[] = [
    'last_10',
    'last_50',
    'last_100',
    'last_500',
    'session',
    'day',
    'week',
    'month',
    'all',
  ];

  const results: Partial<Record<WindowType, MetricSnapshot | null>> = {};

  for (const window of windows) {
    results[window] = aggregateWindow({ ...input, window });
  }

  return results as Record<WindowType, MetricSnapshot | null>;
}

/**
 * Filter outcomes to those within the specified window.
 */
function filterOutcomesByWindow(
  outcomes: BetOutcomeRecord[],
  window: WindowType,
  sessionStartTime?: string
): BetOutcomeRecord[] {
  const now = Date.now();

  switch (window) {
    case 'last_10':
      return outcomes.slice(-10);
    case 'last_50':
      return outcomes.slice(-50);
    case 'last_100':
      return outcomes.slice(-100);
    case 'last_500':
      return outcomes.slice(-500);
    case 'session':
      if (sessionStartTime) {
        const start = new Date(sessionStartTime).getTime();
        return outcomes.filter((o) => new Date(o.timestamp).getTime() >= start);
      }
      return outcomes;
    case 'day': {
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      return outcomes.filter((o) => new Date(o.timestamp).getTime() >= dayStart.getTime());
    }
    case 'week': {
      const weekStart = new Date(now - 7 * 24 * 60 * 60 * 1000);
      return outcomes.filter((o) => new Date(o.timestamp).getTime() >= weekStart.getTime());
    }
    case 'month': {
      const monthStart = new Date(now - 30 * 24 * 60 * 60 * 1000);
      return outcomes.filter((o) => new Date(o.timestamp).getTime() >= monthStart.getTime());
    }
    case 'all':
      return outcomes;
    default:
      return outcomes;
  }
}

/**
 * Filter latency samples to those within the specified window.
 */
function filterLatencyByWindow(
  samples: LatencySample[],
  window: WindowType,
  sessionStartTime?: string
): LatencySample[] {
  const now = Date.now();

  switch (window) {
    case 'last_10':
      return samples.slice(-10);
    case 'last_50':
      return samples.slice(-50);
    case 'last_100':
      return samples.slice(-100);
    case 'last_500':
      return samples.slice(-500);
    case 'session':
      if (sessionStartTime) {
        const start = new Date(sessionStartTime).getTime();
        return samples.filter((s) => new Date(s.timestamp).getTime() >= start);
      }
      return samples;
    case 'day': {
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      return samples.filter((s) => new Date(s.timestamp).getTime() >= dayStart.getTime());
    }
    case 'week': {
      const weekStart = new Date(now - 7 * 24 * 60 * 60 * 1000);
      return samples.filter((s) => new Date(s.timestamp).getTime() >= weekStart.getTime());
    }
    case 'month': {
      const monthStart = new Date(now - 30 * 24 * 60 * 60 * 1000);
      return samples.filter((s) => new Date(s.timestamp).getTime() >= monthStart.getTime());
    }
    case 'all':
      return samples;
    default:
      return samples;
  }
}

/**
 * Get a summary of available windows and their sample counts.
 */
export function getWindowAvailability(
  outcomes: BetOutcomeRecord[],
  window: WindowType
): { available: boolean; sampleCount: number; minRequired: number } {
  const filtered = filterOutcomesByWindow(outcomes, window);
  const resolved = filtered.filter((o) => o.outcome === 'win' || o.outcome === 'loss');
  const minRequired = getMinSamplesForWindow(window);

  return {
    available: resolved.length >= minRequired,
    sampleCount: resolved.length,
    minRequired,
  };
}

/**
 * Format a metric snapshot for Telegram display.
 */
export function formatMetricSnapshot(snapshot: MetricSnapshot): string {
  const ci = snapshot.hitRate.confidenceInterval;
  const pnlEmoji = snapshot.expectedValue.cumulativeRealizedPnl >= 0 ? '🟢' : '🔴';

  const lines = [
    `📊 *Analytics — ${WINDOW_CONFIGS.find((w) => w.type === snapshot.window)?.label || snapshot.window}*`,
    '',
    `*Entries:* ${snapshot.hitRate.sampleSize}`,
    `*Hit Rate:* ${(snapshot.hitRate.observedRate * 100).toFixed(1)}%`,
    `*Break-Even:* ${(snapshot.hitRate.breakEvenRate * 100).toFixed(1)}%`,
    `*95% CI:* [${(ci.lower * 100).toFixed(1)}%, ${(ci.upper * 100).toFixed(1)}%]`,
    `*Net P&L:* ${pnlEmoji} ${snapshot.expectedValue.cumulativeRealizedPnl.toFixed(2)}`,
    `*Expected P&L:* ${snapshot.expectedValue.cumulativeExpectedPnl.toFixed(2)}`,
    `*Max Drawdown:* ${snapshot.drawdown.maxDrawdown.toFixed(2)}`,
    `*Current Drawdown:* ${snapshot.drawdown.currentDrawdown.toFixed(2)}`,
    `*Cash-Out Success:* ${(snapshot.cashOutSuccess.successRate * 100).toFixed(1)}%`,
    `*Latency P95:* ${snapshot.latency.p95.toFixed(0)}ms`,
  ];

  if (snapshot.streaks.currentStreakType !== 'none') {
    const streakEmoji = snapshot.streaks.currentStreakType === 'win' ? '🔥' : '❄️';
    const streakLength =
      snapshot.streaks.currentStreakType === 'win'
        ? snapshot.streaks.currentWinStreak
        : snapshot.streaks.currentLossStreak;
    lines.push(`*Current Streak:* ${streakEmoji} ${streakLength} ${snapshot.streaks.currentStreakType}`);
  }

  if (snapshot.anomalies.length > 0) {
    lines.push('', `*Anomalies:* ${snapshot.anomalies.length} flagged`);
    for (const anomaly of snapshot.anomalies.slice(0, 3)) {
      const emoji = anomaly.severity === 'critical' ? '🔴' : '🟡';
      lines.push(`${emoji} ${anomaly.message}`);
    }
  }

  if (snapshot.recommendations.length > 0) {
    lines.push('', '*Top Recommendation:*');
    const topRec = snapshot.recommendations[0];
    const emoji = topRec.type === 'stop' ? '🛑' : topRec.type === 'pause' ? '⏸️' : topRec.type === 'dry_run' ? '🧪' : '✅';
    lines.push(`${emoji} ${topRec.message}`);
  }

  return lines.join('\n');
}
