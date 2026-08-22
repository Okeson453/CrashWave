/**
 * Analytics Engine — Type Definitions
 *
 * Comprehensive type system for the analytics and learning engine.
 * All calculations are descriptive and evaluative — never predictive.
 */

// PnlEntry and EquityPoint imported from ledger/types when needed

// ─── Window Definitions ──────────────────────────────────────────────────────

export type WindowType =
  | 'last_10'
  | 'last_50'
  | 'last_100'
  | 'last_500'
  | 'session'
  | 'day'
  | 'week'
  | 'month'
  | 'all';

export type WindowSize = 10 | 50 | 100 | 500;

export interface WindowConfig {
  type: WindowType;
  label: string;
  description: string;
  minSamples: number;
}

// ─── Confidence Intervals ────────────────────────────────────────────────────

export interface ConfidenceInterval {
  confidenceLevel: number;
  lower: number;
  upper: number;
  margin: number;
  sampleSize: number;
  isValid: boolean;
}

export interface WilsonScoreInterval extends ConfidenceInterval {
  center: number;
  zScore: number;
}

// ─── Hit Rate Metrics ────────────────────────────────────────────────────────

export interface HitRateMetrics {
  observedRate: number;
  breakEvenRate: number;
  confidenceInterval: WilsonScoreInterval;
  sampleSize: number;
  isAboveBreakEven: boolean;
  breakEvenWithinCI: boolean;
  statisticalSignificance: 'significant_above' | 'significant_below' | 'inconclusive' | 'insufficient_data';
}

// ─── Drawdown Metrics ────────────────────────────────────────────────────────

export interface DrawdownMetrics {
  maxDrawdown: number;
  currentDrawdown: number;
  peakEquity: number;
  currentEquity: number;
  underwaterDuration: number;
  maxUnderwaterDuration: number;
  recoveryCount: number;
  isUnderwater: boolean;
  drawdownSeverity: 'none' | 'mild' | 'moderate' | 'severe' | 'critical';
}

export interface DrawdownPoint {
  timestamp: string;
  equity: number;
  peakEquity: number;
  drawdown: number;
  isUnderwater: boolean;
  durationUnderwater: number;
}

// ─── Streak Metrics ──────────────────────────────────────────────────────────

export interface StreakDistribution {
  length: number;
  count: number;
  frequency: number;
}

export interface StreakMetrics {
  currentWinStreak: number;
  currentLossStreak: number;
  maxWinStreak: number;
  maxLossStreak: number;
  currentStreakType: 'win' | 'loss' | 'none';
  winStreakDistribution: StreakDistribution[];
  lossStreakDistribution: StreakDistribution[];
  expectedMaxWinStreak: number;
  expectedMaxLossStreak: number;
  streakAnomalyScore: number;
}

// ─── Expected Value Metrics ──────────────────────────────────────────────────

export interface ExpectedValueMetrics {
  theoreticalEvPerEntry: number;
  realizedEvPerEntry: number;
  cumulativeExpectedPnl: number;
  cumulativeRealizedPnl: number;
  evVariance: number;
  evStandardError: number;
  evConfidenceInterval: ConfidenceInterval;
  evAccuracy: number; // realized / expected (1.0 = perfect)
}

// ─── Latency Metrics ─────────────────────────────────────────────────────────

export interface LatencyMetrics {
  observationLatencyMs: number;
  executionLatencyMs: number;
  cashoutLatencyMs: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  min: number;
  sampleCount: number;
  degradationTrend: 'improving' | 'stable' | 'degrading' | 'critical';
}

export interface LatencySample {
  timestamp: string;
  type: 'observation' | 'execution' | 'cashout';
  latencyMs: number;
  roundId?: string;
  betId?: string;
}

// ─── Cash-Out Success Metrics ────────────────────────────────────────────────

export interface CashOutSuccessMetrics {
  successRate: number;
  failureRate: number;
  totalAttempts: number;
  successfulCashouts: number;
  failedCashouts: number;
  timeoutCount: number;
  prematureCrashCount: number;
  errorCount: number;
  trendDirection: 'improving' | 'stable' | 'worsening';
  failureModeBreakdown: Record<string, number>;
}

// ─── Anomaly Detection ───────────────────────────────────────────────────────

export type AnomalySeverity = 'minor' | 'moderate' | 'critical';
export type AnomalyCategory =
  | 'hit_rate_drop'
  | 'cashout_failure_spike'
  | 'latency_spike'
  | 'balance_mismatch'
  | 'losing_streak'
  | 'failed_entry_spike'
  | 'observation_degradation'
  | 'reconnect_loop'
  | 'unknown_outcome_spike'
  | 'drawdown_spike';

export interface AnomalyFlag {
  id: string;
  category: AnomalyCategory;
  severity: AnomalySeverity;
  message: string;
  metricName: string;
  observedValue: number;
  expectedValue: number;
  deviationSigma: number;
  threshold: number;
  timestamp: string;
  window: WindowType;
  recommendedAction: string;
}

export interface AnomalyConfig {
  enabled: boolean;
  categories: Partial<Record<AnomalyCategory, {
    enabled: boolean;
    thresholdSigma: number;
    minSamples: number;
    cooldownMs: number;
  }>>;
}

// ─── Recommendations ─────────────────────────────────────────────────────────

export type RecommendationType = 'continue' | 'pause' | 'dry_run' | 'stop' | 'review' | 'reduce_exposure';

export interface Recommendation {
  type: RecommendationType;
  priority: number; // 1 = highest
  message: string;
  rationale: string;
  triggeredBy: string[];
  confidence: number; // 0-1
  triggeredAt: string;
  window: WindowType;
}

export interface RecommendationEngineConfig {
  conservativeMode: boolean;
  minSamplesForRecommendation: number;
  pauseThresholdHitRateDelta: number;
  stopThresholdDrawdownPercent: number;
  dryRunThresholdConsecutiveLosses: number;
  maxRecommendationsPerWindow: number;
}

// ─── Descriptive Analysis ────────────────────────────────────────────────────

export interface CrashDistribution {
  bucket: string;
  minMultiplier: number;
  maxMultiplier: number;
  count: number;
  frequency: number;
  cumulativeFrequency: number;
}

export interface TimeOfDayPattern {
  hour: number;
  entries: number;
  hitRate: number;
  avgPnl: number;
}

export interface SessionEffect {
  sessionDurationMinutes: number;
  entries: number;
  hitRate: number;
  pnl: number;
  latencyMs: number;
}

export interface DescriptiveAnalysis {
  crashDistribution: CrashDistribution[];
  timeOfDayPatterns: TimeOfDayPattern[];
  sessionEffects: SessionEffect[];
  dayOfWeekPatterns: { day: string; entries: number; hitRate: number; pnl: number }[];
  latencyCorrelation: { latencyRange: string; hitRate: number; count: number }[];
}

// ─── Report Types ────────────────────────────────────────────────────────────

export interface DailyReport {
  dailyKey: string;
  entriesConfirmed: number;
  entriesAttempted: number;
  entriesFailed: number;
  wins: number;
  losses: number;
  hitRate: HitRateMetrics;
  netPnl: number;
  expectedPnl: number;
  maxDrawdown: number;
  currentDrawdown: number;
  cashOutSuccessRate: number;
  averageLatencyMs: number;
  recommendations: Recommendation[];
  anomalies: AnomalyFlag[];
  generatedAt: string;
}

export interface SessionReport {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number;
  entries: number;
  wins: number;
  losses: number;
  hitRate: HitRateMetrics;
  netPnl: number;
  maxDrawdown: number;
  currentDrawdown: number;
  streakMetrics: StreakMetrics;
  latencyMetrics: LatencyMetrics;
  cashOutMetrics: CashOutSuccessMetrics;
  recommendations: Recommendation[];
  anomalies: AnomalyFlag[];
  healthScore: number;
  efficiencyScore: number;
}

export interface LearningCurvePoint {
  timestamp: string;
  windowType: WindowType;
  cumulativeEntries: number;
  hitRate: number;
  confidenceLower: number;
  confidenceUpper: number;
  netPnl: number;
  maxDrawdown: number;
  evPerEntry: number;
}

export interface LearningCurveReport {
  points: LearningCurvePoint[];
  trendDirection: 'improving' | 'stable' | 'declining';
  trendStrength: number;
  convergenceEstimate: number | null;
  recommendations: Recommendation[];
  generatedAt: string;
}

// ─── Analytics Engine State ──────────────────────────────────────────────────

export interface AnalyticsEngineConfig {
  windows: WindowConfig[];
  anomalyConfig: AnomalyConfig;
  recommendationConfig: RecommendationEngineConfig;
  stake: number;
  target: number;
  maxDailyEntries: number;
  confidenceLevel: number;
  zScore: number;
}

export interface MetricSnapshot {
  timestamp: string;
  window: WindowType;
  hitRate: HitRateMetrics;
  drawdown: DrawdownMetrics;
  streaks: StreakMetrics;
  expectedValue: ExpectedValueMetrics;
  latency: LatencyMetrics;
  cashOutSuccess: CashOutSuccessMetrics;
  recommendations: Recommendation[];
  anomalies: AnomalyFlag[];
}

export interface AnalyticsSummary {
  window: WindowType;
  windowSize: number;
  entries: number;
  wins: number;
  losses: number;
  hitRate: number;
  breakEvenHitRate: number;
  realizedPnl: number;
  expectedPnl: number;
  maxDrawdown: number;
  currentDrawdown: number;
  recommendation: string;
}

// ─── Raw Data Inputs ─────────────────────────────────────────────────────────

export interface BetOutcomeRecord {
  betId: string;
  roundId: string;
  dailyKey: string;
  timestamp: string;
  outcome: 'win' | 'loss' | 'failed' | 'unknown';
  pnl: number;
  stake: number;
  target: number;
  cashOutMultiplier: number | null;
  latencyMs: number | null;
  cashOutSuccess: boolean | null;
  failureReason: string | null;
}

export interface RoundObservationRecord {
  roundId: string;
  timestamp: string;
  crashPoint: number | null;
  reachedTarget: boolean | null;
  observationLatencyMs: number | null;
}

// ─── Telegram Output ─────────────────────────────────────────────────────────

export interface TelegramAnalyticsPayload {
  command: string;
  summary: AnalyticsSummary;
  hitRateDetails: HitRateMetrics | null;
  drawdownDetails: DrawdownMetrics | null;
  streakDetails: StreakMetrics | null;
  evDetails: ExpectedValueMetrics | null;
  recommendations: Recommendation[];
  anomalies: AnomalyFlag[];
  formattedMessage: string;
}
