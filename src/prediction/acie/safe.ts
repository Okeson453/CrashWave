/**
 * SAFE — Self-Adaptive Forecasting Engine
 * Calibration across all probability bins + Brier / log-loss vs baseline.
 */

import { SOLRecord, CalibrationReport, CalibrationBin } from './types.js';


export class SelfAdaptiveForecastingEngine {
  /**
   * Full calibration report — evaluates every 10% bin (0–10 … 90–100).
   * The 65–70% example is only illustrative, not architecture-critical.
   */
  generateCalibrationReport(records: SOLRecord[]): CalibrationReport {
    if (records.length === 0) {
      return this.emptyReport();
    }

    const bins: CalibrationBin[] = [];
    for (let lower = 0; lower < 1.0 - 1e-9; lower += 0.1) {
      const upper = Math.min(1, lower + 0.1);
      const binRecords = records.filter((r) => {
        if (upper >= 1) return r.psiProbability >= lower && r.psiProbability <= upper;
        return r.psiProbability >= lower && r.psiProbability < upper;
      });
      if (binRecords.length < 5) continue;
      const predicted =
        binRecords.reduce((s, r) => s + r.psiProbability, 0) / binRecords.length;
      const actual = binRecords.filter((r) => r.actualResult).length / binRecords.length;
      bins.push({
        predictedRange: [lower, Number(upper.toFixed(2))],
        predictedProbability: predicted,
        actualFrequency: actual,
        calibrationError: Math.abs(predicted - actual),
        sampleSize: binRecords.length,
      });
    }

    // Illustrative mid-high band (prefer 0.60–0.70, else nearest mid bin)
    const mid =
      bins.find((b) => b.predictedRange[0] === 0.6 && b.predictedRange[1] === 0.7) ??
      bins.find((b) => b.predictedRange[0] >= 0.5 && b.predictedRange[1] <= 0.8) ??
      null;

    const overallBrierScore = this.brierScore(records);
    const baselineFreq = records.filter((r) => r.actualResult).length / records.length;
    const baselineBrier =
      records.reduce((s, r) => {
        const e = baselineFreq - (r.actualResult ? 1 : 0);
        return s + e * e;
      }, 0) / records.length;
    const overallBrierSkillScore =
      baselineBrier > 1e-9 ? 1 - overallBrierScore / baselineBrier : 0;
    const overallLogLoss =
      records.reduce((s, r) => s + r.logLoss, 0) / Math.max(records.length, 1);

    const psiMean =
      records.reduce((s, r) => s + r.psiProbability, 0) / records.length;
    const psiActual = records.filter((r) => r.actualResult).length / records.length;
    const improvement = psiActual - baselineFreq;
    // Rough significance: improvement needs |z|-ish support from sample size
    const se = Math.sqrt((baselineFreq * (1 - baselineFreq)) / Math.max(records.length, 1));
    const isSignificant = Math.abs(improvement) > 1.96 * se && records.length >= 200;

    return {
      overallBrierScore,
      overallBrierSkillScore,
      overallLogLoss,
      bins,
      illustrativeBinCalibration: mid
        ? {
            range: mid.predictedRange,
            predicted: mid.predictedProbability,
            actual: mid.actualFrequency,
            error: mid.calibrationError,
            isWellCalibrated: mid.calibrationError < 0.05,
          }
        : {
            range: [0.6, 0.7],
            predicted: 0,
            actual: 0,
            error: 1,
            isWellCalibrated: false,
          },
      rollingCalibration: this.rollingCalibration(records, 100),
      baselineComparison: {
        naiveFrequency: baselineFreq,
        psiMeanProbability: psiMean,
        psiActualFrequency: psiActual,
        psiImprovement: improvement,
        isSignificant,
      },
    };
  }

  meanAbsoluteCalibrationError(report: CalibrationReport): number {
    if (report.bins.length === 0) return 1;
    const weighted = report.bins.reduce(
      (s, b) => s + b.calibrationError * b.sampleSize,
      0
    );
    const n = report.bins.reduce((s, b) => s + b.sampleSize, 0);
    return n > 0 ? weighted / n : 1;
  }

  private brierScore(records: SOLRecord[]): number {
    if (records.length === 0) return 1;
    return records.reduce((s, r) => s + r.squaredError, 0) / records.length;
  }

  private rollingCalibration(
    records: SOLRecord[],
    window: number
  ): CalibrationReport['rollingCalibration'] {
    const out: CalibrationReport['rollingCalibration'] = [];
    if (records.length < window) return out;
    for (let i = window; i <= records.length; i += Math.max(1, Math.floor(window / 2))) {
      const slice = records.slice(i - window, i);
      const brier = this.brierScore(slice);
      const meanPred = slice.reduce((s, r) => s + r.psiProbability, 0) / slice.length;
      const actual = slice.filter((r) => r.actualResult).length / slice.length;
      out.push({
        windowStart: slice[0].timestamp,
        windowEnd: slice[slice.length - 1].timestamp,
        brierScore: brier,
        calibrationError: Math.abs(meanPred - actual),
        sampleSize: slice.length,
      });
    }
    return out;
  }

  private emptyReport(): CalibrationReport {
    return {
      overallBrierScore: 1,
      overallBrierSkillScore: 0,
      overallLogLoss: 1,
      bins: [],
      illustrativeBinCalibration: {
        range: [0.6, 0.7],
        predicted: 0,
        actual: 0,
        error: 1,
        isWellCalibrated: false,
      },
      rollingCalibration: [],
      baselineComparison: {
        naiveFrequency: 0,
        psiMeanProbability: 0,
        psiActualFrequency: 0,
        psiImprovement: 0,
        isSignificant: false,
      },
    };
  }
}
