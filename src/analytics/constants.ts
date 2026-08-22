/**
 * Analytics Engine — Constants & Configuration
 *
 * Centralized constants for window sizes, thresholds, break-even calculations,
 * and anomaly detection parameters. All values are deterministic and configurable.
 */

import { WindowConfig, WindowType, AnomalyConfig, RecommendationEngineConfig } from './types';

// ─── Window Configurations ───────────────────────────────────────────────────

export const DEFAULT_WINDOW_SIZES: readonly number[] = [10, 50, 100, 500];

export const WINDOW_CONFIGS: readonly WindowConfig[] = [
  { type: 'last_10', label: 'Last 10', description: 'Recent performance (short-term noise)', minSamples: 5 },
  { type: 'last_50', label: 'Last 50', description: 'Near-term performance (emerging trends)', minSamples: 25 },
  { type: 'last_100', label: 'Last 100', description: 'Medium-term performance (reliable signal)', minSamples: 50 },
  { type: 'last_500', label: 'Last 500', description: 'Long-term performance (statistically robust)', minSamples: 250 },
  { type: 'session', label: 'Session', description: 'Current automation session', minSamples: 10 },
  { type: 'day', label: 'Today', description: 'Current calendar day', minSamples: 5 },
  { type: 'week', label: '7 Days', description: 'Rolling 7-day window', minSamples: 50 },
  { type: 'month', label: '30 Days', description: 'Rolling 30-day window', minSamples: 200 },
  { type: 'all', label: 'All Time', description: 'Complete historical record', minSamples: 100 },
];

// ─── Statistical Constants ───────────────────────────────────────────────────

export const CONFIDENCE_LEVEL_95 = 0.95;
export const Z_SCORE_95 = 1.959963984540054; // Exact z-score for 95% confidence
export const Z_SCORE_99 = 2.5758293035489004; // Exact z-score for 99% confidence

// ─── Break-Even Calculations ─────────────────────────────────────────────────

/**
 * Break-even hit rate for a given cash-out target.
 * p_break_even = 1 / target
 */
export function getBreakEvenHitRate(target: number): number {
  if (target <= 1) return 1.0;
  return 1 / target;
}

/**
 * Profit per winning bet.
 * profit = stake * (target - 1)
 */
export function getWinProfit(stake: number, target: number): number {
  return stake * (target - 1);
}

/**
 * Loss per losing bet.
 * loss = -stake
 */
export function getLossAmount(stake: number): number {
  return -stake;
}

/**
 * Expected value per entry.
 * EV = stake * (p * target - 1)
 */
export function getExpectedValue(stake: number, hitRate: number, target: number): number {
  return stake * (hitRate * target - 1);
}

// ─── Default Betting Parameters ──────────────────────────────────────────────

export const DEFAULT_STAKE = 700;
export const DEFAULT_TARGET = 1.30;
export const DEFAULT_MAX_DAILY_ENTRIES = 100;

export const DEFAULT_BREAK_EVEN_HIT_RATE = getBreakEvenHitRate(DEFAULT_TARGET); // ≈ 0.76923
export const DEFAULT_WIN_PROFIT = getWinProfit(DEFAULT_STAKE, DEFAULT_TARGET); // 210
export const DEFAULT_LOSS_AMOUNT = getLossAmount(DEFAULT_STAKE); // -700

// ─── Drawdown Thresholds ─────────────────────────────────────────────────────

export const DRAWDOWN_SEVERITY_THRESHOLDS = {
  none: 0,
  mild: 0.05,      // 5% of peak equity
  moderate: 0.10,  // 10% of peak equity
  severe: 0.20,    // 20% of peak equity
  critical: 0.30,  // 30% of peak equity
} as const;

export const DRAWDOWN_ABSOLUTE_THRESHOLDS = {
  mild: 500,
  moderate: 1500,
  severe: 3500,
  critical: 7000,
} as const;

// ─── Latency Thresholds ──────────────────────────────────────────────────────

export const LATENCY_THRESHOLDS = {
  healthy: 500,    // ms
  degraded: 1000,  // ms
  critical: 2000,  // ms
} as const;

// ─── Cash-Out Success Thresholds ─────────────────────────────────────────────

export const CASHOUT_SUCCESS_THRESHOLDS = {
  excellent: 0.99,
  good: 0.97,
  acceptable: 0.95,
  poor: 0.90,
  critical: 0.85,
} as const;

// ─── Anomaly Detection Defaults ──────────────────────────────────────────────

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  enabled: true,
  categories: {
    hit_rate_drop: {
      enabled: true,
      thresholdSigma: 2.5,
      minSamples: 50,
      cooldownMs: 300000, // 5 minutes
    },
    cashout_failure_spike: {
      enabled: true,
      thresholdSigma: 2.0,
      minSamples: 20,
      cooldownMs: 180000, // 3 minutes
    },
    latency_spike: {
      enabled: true,
      thresholdSigma: 3.0,
      minSamples: 30,
      cooldownMs: 120000, // 2 minutes
    },
    balance_mismatch: {
      enabled: true,
      thresholdSigma: 2.0,
      minSamples: 1,
      cooldownMs: 60000, // 1 minute
    },
    losing_streak: {
      enabled: true,
      thresholdSigma: 2.5,
      minSamples: 10,
      cooldownMs: 300000, // 5 minutes
    },
    failed_entry_spike: {
      enabled: true,
      thresholdSigma: 2.0,
      minSamples: 10,
      cooldownMs: 180000, // 3 minutes
    },
    observation_degradation: {
      enabled: true,
      thresholdSigma: 2.0,
      minSamples: 20,
      cooldownMs: 120000, // 2 minutes
    },
    reconnect_loop: {
      enabled: true,
      thresholdSigma: 2.0,
      minSamples: 3,
      cooldownMs: 60000, // 1 minute
    },
    unknown_outcome_spike: {
      enabled: true,
      thresholdSigma: 2.0,
      minSamples: 10,
      cooldownMs: 180000, // 3 minutes
    },
    drawdown_spike: {
      enabled: true,
      thresholdSigma: 2.5,
      minSamples: 20,
      cooldownMs: 300000, // 5 minutes
    },
  },
};

// ─── Recommendation Engine Defaults ──────────────────────────────────────────

export const DEFAULT_RECOMMENDATION_CONFIG: RecommendationEngineConfig = {
  conservativeMode: true,
  minSamplesForRecommendation: 30,
  pauseThresholdHitRateDelta: 0.02, // 2% below break-even
  stopThresholdDrawdownPercent: 0.25, // 25% of bankroll
  dryRunThresholdConsecutiveLosses: 5,
  maxRecommendationsPerWindow: 3,
};

// ─── Streak Analysis Constants ───────────────────────────────────────────────

export const STREAK_MAX_TRACKED_LENGTH = 20;

// ─── Report Generation Constants ─────────────────────────────────────────────

export const REPORT_GENERATION_INTERVAL_MS = 300000; // 5 minutes
export const DAILY_REPORT_HOUR = 23;
export const DAILY_REPORT_MINUTE = 55;

// ─── Learning Curve Constants ────────────────────────────────────────────────

export const LEARNING_CURVE_MIN_POINTS = 5;
export const LEARNING_CURVE_WINDOW_STEP = 10;

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Map a window type to its numeric size (if applicable).
 */
export function windowTypeToSize(type: WindowType): number | null {
  switch (type) {
    case 'last_10': return 10;
    case 'last_50': return 50;
    case 'last_100': return 100;
    case 'last_500': return 500;
    default: return null;
  }
}

/**
 * Get the minimum samples required for a given window type.
 */
export function getMinSamplesForWindow(type: WindowType): number {
  const config = WINDOW_CONFIGS.find((w) => w.type === type);
  return config?.minSamples ?? 10;
}

/**
 * Determine drawdown severity based on absolute drawdown amount.
 */
export function classifyDrawdownSeverity(drawdown: number): 'none' | 'mild' | 'moderate' | 'severe' | 'critical' {
  if (drawdown <= 0) return 'none';
  if (drawdown >= DRAWDOWN_ABSOLUTE_THRESHOLDS.critical) return 'critical';
  if (drawdown >= DRAWDOWN_ABSOLUTE_THRESHOLDS.severe) return 'severe';
  if (drawdown >= DRAWDOWN_ABSOLUTE_THRESHOLDS.moderate) return 'moderate';
  if (drawdown >= DRAWDOWN_ABSOLUTE_THRESHOLDS.mild) return 'mild';
  return 'none';
}

/**
 * Determine latency degradation trend.
 */
export function classifyLatencyTrend(p95: number): 'improving' | 'stable' | 'degrading' | 'critical' {
  if (p95 < LATENCY_THRESHOLDS.healthy) return 'improving';
  if (p95 < LATENCY_THRESHOLDS.degraded) return 'stable';
  if (p95 < LATENCY_THRESHOLDS.critical) return 'degrading';
  return 'critical';
}

/**
 * Determine cash-out success trend.
 */
export function classifyCashOutTrend(rate: number): 'improving' | 'stable' | 'worsening' {
  if (rate >= CASHOUT_SUCCESS_THRESHOLDS.excellent) return 'improving';
  if (rate >= CASHOUT_SUCCESS_THRESHOLDS.acceptable) return 'stable';
  return 'worsening';
}
