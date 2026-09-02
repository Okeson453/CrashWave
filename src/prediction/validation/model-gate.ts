/**
 * Model promotion gate — requires OOS skill vs baseline, calibration not worse,
 * no catastrophic drawdown flag.
 */

import type { CalibrationValidationResult } from './calibration-validator.js';

export interface ModelGateMetrics {
  brier: number;
  logLoss: number;
  ece: number;
  oosSkill: number;
  maxDrawdown?: number;
  sampleSize: number;
}

export interface ModelGateResult {
  allowed: boolean;
  reasons: string[];
}

export function evaluateModelGate(
  candidate: ModelGateMetrics,
  baseline: ModelGateMetrics,
  calibration?: CalibrationValidationResult
): ModelGateResult {
  const reasons: string[] = [];
  if (candidate.sampleSize < 500) reasons.push('sampleSize < 500');
  if (candidate.oosSkill <= baseline.oosSkill) reasons.push('oosSkill not improved');
  if (candidate.brier > baseline.brier) reasons.push('brier worse than baseline');
  if (candidate.logLoss > baseline.logLoss) reasons.push('logLoss worse than baseline');
  if (candidate.ece > baseline.ece + 0.01) reasons.push('ECE worse than baseline+0.01');
  if (calibration && !calibration.passed) reasons.push(`calibration: ${calibration.detail}`);
  if (candidate.maxDrawdown != null && candidate.maxDrawdown > 0.12) {
    reasons.push('maxDrawdown > 12%');
  }
  return { allowed: reasons.length === 0, reasons };
}
