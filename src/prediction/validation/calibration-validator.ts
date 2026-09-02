/**
 * Calibration acceptance validator — ECE ≤ 0.05 target.
 */

import { expectedCalibrationError, emptyBins, updateBin } from '../calibration/calibration-metrics.js';

export interface CalibrationValidationResult {
  ece: number;
  brier: number;
  logLoss: number;
  n: number;
  passed: boolean;
  targetEce: number;
  detail: string;
}

export function validateCalibration(
  pairs: Array<{ p: number; y: 0 | 1 }>,
  targetEce = 0.05
): CalibrationValidationResult {
  const bins = emptyBins(10);
  let brier = 0;
  let ll = 0;
  for (const { p, y } of pairs) {
    const q = Math.min(0.999, Math.max(0.001, p));
    updateBin(bins, q, y);
    brier += (q - y) ** 2;
    ll += y === 1 ? -Math.log(q) : -Math.log(1 - q);
  }
  const n = pairs.length;
  const ece = expectedCalibrationError(bins);
  return {
    ece,
    brier: n ? brier / n : 0,
    logLoss: n ? ll / n : 0,
    n,
    passed: n >= 50 && ece <= targetEce,
    targetEce,
    detail: n < 50 ? 'insufficient samples' : ece <= targetEce ? 'ECE within budget' : 'ECE exceeds budget',
  };
}
