/**
 * Sheath Mode — controlled protective degradation.
 * Design ref: Section 4
 */

export type SheathState =
  | 'NORMAL'
  | 'SHEATH_EVALUATING'
  | 'SHEATH_ACTIVE'
  | 'SHEATH_RECOVERING'
  | 'SHEATH_PERSISTENT';

export type SheathSeverity = 'critical' | 'high' | 'medium' | 'manual';

export type SheathTriggerId =
  | 'low_prediction_confidence'
  | 'poor_prediction_accuracy'
  | 'abnormal_market'
  | 'data_quality_degradation'
  | 'worker_instability'
  | 'excessive_false_signals'
  | 'execution_problems'
  | 'api_failures'
  | 'model_drift'
  | 'unexpected_volatility'
  | 'risk_thresholds'
  | 'system_health_degradation'
  | 'queue_backlog'
  | 'operator_command'
  | 'prediction_divergence'
  | 'prediction_calibration_degraded'
  | 'prediction_cold_state';

export interface SheathTrigger {
  id: SheathTriggerId;
  severity: SheathSeverity;
  message: string;
  detectedAt: string;
  metadata?: Record<string, unknown>;
}

export interface SheathTransition {
  previous: SheathState;
  next: SheathState;
  triggers: SheathTrigger[];
  timestamp: string;
  operatorCommand?: string;
  recoveryResults?: RecoveryCheckResult[];
}

export interface RecoveryCheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface SheathModeSnapshot {
  state: SheathState;
  activeTriggers: SheathTrigger[];
  evaluatingSince: string | null;
  recoveringSince: string | null;
  recoveryAttempts: number;
  consecutiveRecoveryRounds: number;
  lastTransition: SheathTransition | null;
  bettingSuspended: boolean;
  intelligenceActive: boolean;
}
