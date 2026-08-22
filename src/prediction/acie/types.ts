/**
 * ACIE v3 — 1.30× Threshold-Probability Intelligence types.
 *
 * Central question: P(next crash ≥ 1.30× | sequence, regime, temporal state, history)
 *
 * Corrections applied:
 * - Evidence ≠ entry eligibility (Strategy policy decides)
 * - Signal = opportunity that passes strategy (+ risk downstream)
 * - Calibration across all probability bins
 * - Residuals: probabilityResidual, squaredError, logLoss
 */

export const ACIE_TARGET = 1.3 as const;
export type RegimeLabel =
  | 'normal'
  | 'low-cluster'
  | 'volatile'
  | 'high-activity'
  | 'deep-low'
  | 'anomalous'
  | 'unknown';

export interface SequenceState {
  last10Reached130: number;
  last10AvgCrash: number;
  currentStreakBelow130: number;
  currentStreakAbove130: number;
  lowClusterActive: boolean;
  lowClusterLength: number;
  lowClusterSeverity: number;
  rolling100HitRate: number;
  rolling500HitRate: number;
  rolling1000HitRate: number;
  recentVolatility: number;
  volatilityTrend: 'increasing' | 'decreasing' | 'stable';
}

export interface SOLRecord {
  roundId: string;
  timestamp: string;
  crashPoint: number;
  reached130: boolean;
  previousOutcomes: number[];
  previousReached130: boolean[];
  sequenceState: SequenceState;
  regime: RegimeLabel;
  regimeDuration: number;
  psiProbability: number;
  psiConfidence: number;
  prediction: boolean;
  actualResult: boolean;
  /** Signed residual: psiProbability - actual (0|1) */
  probabilityResidual: number;
  squaredError: number;
  logLoss: number;
  binnedProbability: number;
}

export interface PredictionContext {
  history: Array<{ crashPoint: number; roundId?: string; timestamp?: string }>;
  sequenceState: SequenceState;
  regime: RegimeLabel;
  regimeDuration: number;
  psiProbability: number;
  psiConfidence: number;
  prediction: boolean;
}

export interface PSIOutput {
  target: typeof ACIE_TARGET;
  estimatedProbability: number;
  confidenceInterval: [number, number];
  sequenceState: SequenceState;
  regime: RegimeLabel;
  primaryModel: string;
  ensembleWeight: number;
  modelUncertainty: number;
  dataUncertainty: number;
}

export type EvidenceStatus = 'SUPPORTED' | 'WEAK' | 'INSUFFICIENT' | 'DEGRADED';

export interface CalibrationBin {
  predictedRange: [number, number];
  predictedProbability: number;
  actualFrequency: number;
  calibrationError: number;
  sampleSize: number;
}

export interface CalibrationReport {
  overallBrierScore: number;
  overallBrierSkillScore: number;
  overallLogLoss: number;
  bins: CalibrationBin[];
  /** Illustrative mid-high band (e.g. 0.60–0.70); not architecture-critical */
  illustrativeBinCalibration: {
    range: [number, number];
    predicted: number;
    actual: number;
    error: number;
    isWellCalibrated: boolean;
  };
  rollingCalibration: Array<{
    windowStart: string;
    windowEnd: string;
    brierScore: number;
    calibrationError: number;
    sampleSize: number;
  }>;
  baselineComparison: {
    naiveFrequency: number;
    psiMeanProbability: number;
    psiActualFrequency: number;
    psiImprovement: number;
    isSignificant: boolean;
  };
}

export interface EvidenceReport {
  status: EvidenceStatus;
  baselineProbability: number;
  conditionalImprovement: number;
  improvementSignificant: boolean;
  calibrationStatus: 'excellent' | 'good' | 'poor' | 'unknown';
  meanCalibrationError: number;
  performanceTrend: 'improving' | 'stable' | 'degrading';
  driftDetected: boolean;
  sampleSize: number;
  sampleAdequate: boolean;
  recommendedMode: 'ACTIVE' | 'CAUTIOUS' | 'OBSERVATION';
  reasoning: string;
  calibration: CalibrationReport | null;
}

export interface StrategyRiskState {
  currentExposure: number;
  consecutiveLosses: number;
  dailyEntriesUsed: number;
  dailyEntriesLimit: number;
  balance: number;
}

export interface StrategyDecisionContext {
  target: typeof ACIE_TARGET;
  probability: number;
  confidenceInterval: [number, number];
  calibrationError: number;
  evidence: EvidenceStatus;
  regime: RegimeLabel;
  regimeStability: number;
  uncertainty: { model: number; data: number; total: number };
  riskState: StrategyRiskState;
  /** Baseline frequency used when policy falls back */
  baselineProbability: number;
}

/**
 * Strategy policy — separates intelligence quality from entry eligibility.
 * Product can still evaluate and deliver opportunities under weak evidence
 * without treating "edge proven" as a hard prerequisite.
 */
export type StrategyPolicyMode =
  | 'strict' // skip when evidence is INSUFFICIENT/DEGRADED
  | 'adaptive' // higher thresholds / reduced stake when weak
  | 'frequency_fallback'; // use baseline P when evidence weak so product can still enter

export interface StrategyPolicy {
  mode: StrategyPolicyMode;
  /** Min P for ENTRY when evidence SUPPORTED */
  supportedThreshold: number;
  /** Min P for ENTRY when evidence WEAK */
  weakThreshold: number;
  /** Min P vs baseline when using frequency_fallback */
  fallbackThreshold: number;
  maxCalibrationError: number;
  highUncertainty: number;
  consecutiveLossReduceAt: number;
  reducedStakeFactor: number;
  defaultStake: number;
}

export interface StrategyDecision {
  action: 'ENTRY' | 'SKIP' | 'REDUCED_ENTRY';
  stake: number;
  reason: string;
  confidence: number;
  /** True when this decision is an entry opportunity candidate (ENTRY or REDUCED_ENTRY) */
  isOpportunity: boolean;
}

export interface EntitlementCheck {
  userId: string;
  planName: string;
  dailyEntriesUsed: number;
  dailyEntriesLimit: number;
}

export interface EntitlementResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Formal signal: ACIE-scored opportunity that passed strategy (and later risk).
 * Not synonymous with "statistically proven edge."
 */
export interface EntrySignal {
  target: typeof ACIE_TARGET;
  probability: number;
  confidenceInterval: [number, number];
  evidence: EvidenceStatus;
  regime: RegimeLabel;
  action: 'ENTRY' | 'REDUCED_ENTRY';
  stake: number;
  reason: string;
  confidence: number;
  timestamp: string;
  psi: PSIOutput;
  evidenceReport: EvidenceReport;
}

export interface ACIERoundInput {
  roundId: string;
  crashPoint: number;
  timestamp?: string;
}

export interface ACIEEvaluationResult {
  psi: PSIOutput;
  evidence: EvidenceReport;
  strategy: StrategyDecision;
  signal: EntrySignal | null;
  sequenceState: SequenceState;
  regime: RegimeLabel;
}
