/**
 * StatisticalValidator — baseline comparisons, precision/recall, Brier score, ECE.
 * Calibration uses absolute / binned probability error (signed residuals must not cancel).
 */

import { Dataset, ValidationMetrics, ThresholdTarget } from '../types.js';

export interface CalibrationReport {
  brierScore: number;
  expectedCalibrationError: number;
  meanAbsoluteError: number;
  reliabilityBins: Array<{
    binLower: number;
    binUpper: number;
    count: number;
    meanPredicted: number;
    meanActual: number;
    gap: number;
  }>;
}

export class StatisticalValidator {
  evaluate(
    scores: number[],
    dataset: Dataset,
    target: ThresholdTarget,
    decisionThreshold = 0.5
  ): ValidationMetrics {
    const key = target.toFixed(2);
    const n = Math.min(scores.length, dataset.rows.length);
    if (n === 0) return this.emptyMetrics();

    let tp = 0, fp = 0, tn = 0, fn = 0, baselinePos = 0;
    const actuals: number[] = [];
    const probs: number[] = [];

    for (let i = 0; i < n; i++) {
      const actual = dataset.rows[i].label.thresholds[key] ?? 0;
      const pred = scores[i] >= decisionThreshold ? 1 : 0;
      if (actual === 1) baselinePos++;
      if (pred === 1 && actual === 1) tp++;
      else if (pred === 1 && actual === 0) fp++;
      else if (pred === 0 && actual === 0) tn++;
      else fn++;
      actuals.push(actual);
      probs.push(Math.max(0, Math.min(1, scores[i])));
    }

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;
    const fnr = fn + tp > 0 ? fn / (fn + tp) : 0;
    const cal = this.computeCalibration(probs, actuals);

    return {
      sampleSize: n,
      baselineProbability: baselinePos / n,
      conditionalProbability: precision,
      precision,
      recall,
      f1,
      falsePositiveRate: fpr,
      falseNegativeRate: fnr,
      calibrationError: cal.meanAbsoluteError,
      confidenceInterval95: this.wilsonInterval(tp, tp + fp),
      brierScore: cal.brierScore,
      expectedCalibrationError: cal.expectedCalibrationError,
    };
  }

  computeCalibration(probabilities: number[], actuals: number[], numBins = 10): CalibrationReport {
    const n = Math.min(probabilities.length, actuals.length);
    if (n === 0) {
      return { brierScore: 0, expectedCalibrationError: 0, meanAbsoluteError: 0, reliabilityBins: [] };
    }
    let brierSum = 0, absSum = 0;
    const bins = Array.from({ length: numBins }, () => ({ sumP: 0, sumA: 0, count: 0 }));
    for (let i = 0; i < n; i++) {
      const p = Math.max(0, Math.min(1, probabilities[i]));
      const a = actuals[i] === 1 ? 1 : 0;
      brierSum += (p - a) ** 2;
      absSum += Math.abs(p - a);
      let binIdx = Math.floor(p * numBins);
      if (binIdx >= numBins) binIdx = numBins - 1;
      bins[binIdx].sumP += p;
      bins[binIdx].sumA += a;
      bins[binIdx].count += 1;
    }
    let ece = 0;
    const reliabilityBins = bins.map((b, i) => {
      const binLower = i / numBins;
      const binUpper = (i + 1) / numBins;
      if (b.count === 0) {
        return { binLower, binUpper, count: 0, meanPredicted: 0, meanActual: 0, gap: 0 };
      }
      const meanPredicted = b.sumP / b.count;
      const meanActual = b.sumA / b.count;
      const gap = Math.abs(meanPredicted - meanActual);
      ece += (b.count / n) * gap;
      return { binLower, binUpper, count: b.count, meanPredicted, meanActual, gap };
    });
    return {
      brierScore: brierSum / n,
      expectedCalibrationError: ece,
      meanAbsoluteError: absSum / n,
      reliabilityBins,
    };
  }

  unconditionalBaseline(dataset: Dataset, target: ThresholdTarget): number {
    const key = target.toFixed(2);
    if (dataset.rows.length === 0) return 0;
    return dataset.rows.filter((r) => (r.label.thresholds[key] ?? 0) === 1).length / dataset.rows.length;
  }

  private wilsonInterval(successes: number, total: number): [number, number] {
    if (total === 0) return [0, 0];
    const z = 1.96;
    const p = successes / total;
    const denom = 1 + (z * z) / total;
    const centre = p + (z * z) / (2 * total);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
    return [Math.max(0, (centre - margin) / denom), Math.min(1, (centre + margin) / denom)];
  }

  private emptyMetrics(): ValidationMetrics {
    return {
      sampleSize: 0, baselineProbability: 0, conditionalProbability: 0,
      precision: 0, recall: 0, f1: 0, falsePositiveRate: 0, falseNegativeRate: 0,
      calibrationError: 0, confidenceInterval95: [0, 0], brierScore: 0, expectedCalibrationError: 0,
    };
  }
}
