/**
 * Prediction subsystem domain types.
 * Analytics = what happened; Prediction = model estimate; Risk = allowed?; Execution = act.
 */

export type ThresholdTarget = 1.3 | 2.0 | 5.0 | 10.0;
export const SUPPORTED_TARGETS: readonly ThresholdTarget[] = [1.3, 2.0, 5.0, 10.0] as const;
export type FeatureVersion = string;
export type TargetVersion = string;

export interface ModelIdentity {
  name: string;
  version: string;
  featureVersion: FeatureVersion;
  targetVersion: TargetVersion;
}

export interface HistoricalRound {
  id: string;
  externalRoundId: string;
  sessionId: string | null;
  startedAt: string | null;
  crashedAt: string | null;
  crashPoint: number;
  observationSource: string | null;
  dataQuality: 'high' | 'medium' | 'low' | null;
  createdAt: string;
  sequenceIndex?: number;
}

export interface FeatureVector {
  roundId: string;
  timestamp: string;
  featureVersion: FeatureVersion;
  values: Record<string, number>;
  meta: {
    sampleSize: number;
    dataQualityScore: number;
    missingFeatureCount: number;
    regimeHint?: string;
  };
}

export interface Label {
  roundId: string;
  targetVersion: TargetVersion;
  thresholds: Record<string, 0 | 1>;
  crashPoint: number;
  timestamp: string;
}

export interface DatasetRow {
  features: FeatureVector;
  label: Label;
}

export interface DatasetMeta {
  id: string;
  featureVersion: FeatureVersion;
  targetVersion: TargetVersion;
  sourceFrom: string;
  sourceTo: string;
  generatedAt: string;
  sampleCount: number;
  classDistribution: Record<string, number>;
  missingDataStats: Record<string, number>;
  leakageCheckPassed: boolean;
  configHash: string;
}

export interface Dataset {
  meta: DatasetMeta;
  rows: DatasetRow[];
}

export interface Regime {
  id: string;
  name: string;
  dimensions: {
    lowMultiplierConcentration: number;
    highMultiplierConcentration: number;
    volatility: number;
    streakState: 'low' | 'high' | 'mixed' | 'neutral';
    thresholdFrequency: Record<string, number>;
    anomalyState: boolean;
  };
  confidence: number;
  explanation: string[];
  detectedAt: string;
}

export interface PredictionOutput {
  predictionId: string;
  model: ModelIdentity;
  target: ThresholdTarget;
  score: number;
  probability: number;
  confidence: number;
  regime: Regime | null;
  dataQuality: number;
  featureSummary: Record<string, number>;
  reasoning: string[];
  timestamp: string;
  expiresAt: string;
}

export interface PredictionSignal {
  readonly predictionId: string;
  readonly timestamp: string;
  readonly modelVersion: string;
  readonly featureVersion: string;
  readonly target: ThresholdTarget;
  readonly score: number;
  readonly probability: number;
  readonly confidence: number;
  readonly regimeId: string | null;
  readonly dataQuality: number;
  readonly reasoning: readonly string[];
  readonly expiresAt: string;
  readonly featureSummary: Readonly<Record<string, number>>;
}

export interface ValidationMetrics {
  sampleSize: number;
  baselineProbability: number;
  conditionalProbability: number;
  precision: number;
  recall: number;
  f1: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  calibrationError: number;
  confidenceInterval95: [number, number];
  /** Brier score (mean squared probability error) */
  brierScore?: number;
  /** Expected Calibration Error across equal-width bins */
  expectedCalibrationError?: number;
  regimeBreakdown?: Record<string, Partial<ValidationMetrics>>;
}

export interface BacktestConfig {
  from: string;
  to: string;
  target: ThresholdTarget;
  entryProbabilityThreshold: number;
  minConfidence: number;
  cashoutTarget: number;
  stake: number;
  maxDailyEntries: number;
  maxDrawdownPct: number;
  modelName: string;
  modelVersion: string;
}

export interface BacktestDecision {
  roundId: string;
  timestamp: string;
  signal: PredictionSignal | null;
  riskApproved: boolean;
  riskRejectionReason?: string;
  entered: boolean;
  outcome: 'win' | 'loss' | 'skip';
  pnl: number;
  cumulativePnl: number;
  drawdown: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  decisions: BacktestDecision[];
  metrics: {
    totalRounds: number;
    signalsGenerated: number;
    signalsAccepted: number;
    signalsRejected: number;
    wins: number;
    losses: number;
    hitRate: number;
    totalPnl: number;
    maxDrawdown: number;
    profitFactor: number;
    expectedValue: number;
    exposure: number;
  };
  generatedAt: string;
}

export interface WalkForwardWindow {
  trainFrom: string;
  trainTo: string;
  valFrom: string;
  valTo: string;
  testFrom: string;
  testTo: string;
  validationMetrics: ValidationMetrics;
  testMetrics: ValidationMetrics;
  backtest?: BacktestResult;
}
