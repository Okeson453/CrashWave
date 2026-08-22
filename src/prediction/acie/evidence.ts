/**
 * Evidence Engine — does sequence/state info improve P(≥1.30) vs baseline?
 * Status: SUPPORTED | WEAK | INSUFFICIENT | DEGRADED (operational, not philosophical).
 */

import { SOLRecord, EvidenceReport, EvidenceStatus } from './types.js';
import { SelfAdaptiveForecastingEngine } from './safe.js';

const MIN_SAMPLE = 500;

export class EvidenceEngine {
  private readonly safe = new SelfAdaptiveForecastingEngine();

  evaluate(records: SOLRecord[]): EvidenceReport {
    const sampleSize = records.length;
    const sampleAdequate = sampleSize >= MIN_SAMPLE;
    const calibration = this.safe.generateCalibrationReport(records);
    const meanCalErr = this.safe.meanAbsoluteCalibrationError(calibration);
    const baseline = calibration.baselineComparison.naiveFrequency;
    const improvement = calibration.baselineComparison.psiImprovement;
    const improvementSignificant = calibration.baselineComparison.isSignificant;
    const skill = calibration.overallBrierSkillScore;

    let calibrationStatus: EvidenceReport['calibrationStatus'] = 'unknown';
    if (sampleSize >= 100) {
      if (meanCalErr < 0.03) calibrationStatus = 'excellent';
      else if (meanCalErr < 0.07) calibrationStatus = 'good';
      else calibrationStatus = 'poor';
    }

    const trend = this.trendFromRolling(calibration.rollingCalibration);
    const driftDetected =
      trend === 'degrading' ||
      (calibration.rollingCalibration.length >= 2 &&
        calibration.rollingCalibration[calibration.rollingCalibration.length - 1]
          .calibrationError >
          calibration.rollingCalibration[0].calibrationError + 0.05);

    const meanResidual =
      sampleSize > 0
        ? records.reduce((s, r) => s + r.probabilityResidual, 0) / sampleSize
        : 0;
    // Systematically over-confident or under-performing vs baseline
    const systematicallyBad =
      sampleSize >= 150 &&
      (skill < -0.02 ||
        (improvement < -0.02 && sampleAdequate) ||
        (meanResidual > 0.15 && baseline < 0.45) ||
        (meanResidual < -0.15 && baseline > 0.55) ||
        (calibration.overallBrierScore > 0.35 && sampleSize >= 200));

    let status: EvidenceStatus;
    let recommendedMode: EvidenceReport['recommendedMode'];
    let reasoning: string;

    if (sampleSize < 150) {
      status = 'INSUFFICIENT';
      recommendedMode = 'OBSERVATION';
      reasoning = `Sample size ${sampleSize} below reliable inference threshold (${MIN_SAMPLE}).`;
    } else if (systematicallyBad) {
      status = 'DEGRADED';
      recommendedMode = 'OBSERVATION';
      reasoning = `PSI underperforms naive baseline (skill=${skill.toFixed(3)}, improvement=${(improvement * 100).toFixed(1)}%, residual=${meanResidual.toFixed(3)}).`;
    } else if (
      sampleAdequate &&
      improvementSignificant &&
      skill > 0.02 &&
      calibrationStatus !== 'poor' &&
      !driftDetected
    ) {
      status = 'SUPPORTED';
      recommendedMode = 'ACTIVE';
      reasoning = `PSI improves baseline by ${(improvement * 100).toFixed(1)}% with skill ${skill.toFixed(3)}; calibration ${calibrationStatus}.`;
    } else if (skill > 0 || improvement > 0) {
      status = 'WEAK';
      recommendedMode = 'CAUTIOUS';
      reasoning = `Some positive signal but not yet robust (skill=${skill.toFixed(3)}, n=${sampleSize}, significant=${improvementSignificant}).`;
    } else {
      status = 'INSUFFICIENT';
      recommendedMode = 'OBSERVATION';
      reasoning = `Insufficient evidence of reliable edge over baseline frequency ${((baseline || 0) * 100).toFixed(1)}%.`;
    }

    return {
      status,
      baselineProbability: baseline,
      conditionalImprovement: improvement,
      improvementSignificant,
      calibrationStatus,
      meanCalibrationError: meanCalErr,
      performanceTrend: trend,
      driftDetected,
      sampleSize,
      sampleAdequate,
      recommendedMode,
      reasoning,
      calibration,
    };
  }

  private trendFromRolling(
    rolling: { brierScore: number; calibrationError: number }[]
  ): EvidenceReport['performanceTrend'] {
    if (rolling.length < 3) return 'stable';
    const first = rolling.slice(0, Math.floor(rolling.length / 3));
    const last = rolling.slice(-Math.floor(rolling.length / 3));
    const avg = (xs: { brierScore: number }[]) =>
      xs.reduce((s, x) => s + x.brierScore, 0) / xs.length;
    const a = avg(first);
    const b = avg(last);
    if (b < a * 0.92) return 'improving';
    if (b > a * 1.08) return 'degrading';
    return 'stable';
  }
}
