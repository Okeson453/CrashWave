/**
 * Phase 6 — Multi-target evaluation (1.30 / 2.00 / 5.00)
 * Never picks max raw EV alone; requires margin, confidence, sample size.
 */

export const MULTI_TARGETS = [1.3, 2.0, 5.0] as const;
export type MultiTarget = (typeof MULTI_TARGETS)[number];

export interface TargetAssessment {
  target: MultiTarget;
  rawProbability: number;
  calibratedProbability: number;
  confidence: number;
  sampleSize: number;
  historicalHitRate: number;
  /** EV = p * target - 1 (for even-money style stake recovery) */
  expectedValue: number;
  /** Shrinkage toward baseline frequency */
  shrunkEV: number;
}

export interface MultiTargetSelection {
  selected: TargetAssessment;
  alternatives: TargetAssessment[];
  switchedFromDefault: boolean;
  reason: string;
}

const DEFAULT_TARGET: MultiTarget = 1.3;

export interface MultiTargetPolicy {
  minConfidence: number;
  minSampleSize: number;
  minSwitchMarginEV: number;
  shrinkageStrength: number;
}

export const DEFAULT_MULTI_TARGET_POLICY: MultiTargetPolicy = {
  minConfidence: 0.45,
  minSampleSize: 40,
  minSwitchMarginEV: 0.04,
  shrinkageStrength: 0.35,
};

export class MultiTargetEngine {
  constructor(private readonly policy: MultiTargetPolicy = DEFAULT_MULTI_TARGET_POLICY) {}

  assess(params: {
    probabilities: Record<MultiTarget, number>;
    calibrated: Record<MultiTarget, number>;
    confidence: number;
    sampleSize: number;
    historicalHitRates: Record<MultiTarget, number>;
  }): TargetAssessment[] {
    const out: TargetAssessment[] = [];
    for (const t of MULTI_TARGETS) {
      const raw = params.probabilities[t] ?? 0.5;
      const cal = params.calibrated[t] ?? raw;
      const hist = params.historicalHitRates[t] ?? raw;
      const ev = cal * t - 1;
      // Sample-size aware: shrink = k/(k+n); policy.shrinkageStrength ≈ prior strength k scale
      const k = Math.max(1, this.policy.shrinkageStrength * 100); // 0.35 → k≈35
      const n = Math.max(0, params.sampleSize);
      const shrink = k / (k + n);
      const baselineEV = hist * t - 1;
      const shrunkEV = (1 - shrink) * ev + shrink * baselineEV;
      out.push({
        target: t,
        rawProbability: raw,
        calibratedProbability: cal,
        confidence: params.confidence,
        sampleSize: params.sampleSize,
        historicalHitRate: hist,
        expectedValue: ev,
        shrunkEV,
      });
    }
    return out;
  }

  select(assessments: TargetAssessment[]): MultiTargetSelection {
    const def =
      assessments.find((a) => a.target === DEFAULT_TARGET) ?? assessments[0];
    let best = def;
    for (const a of assessments) {
      if (a.target === DEFAULT_TARGET) continue;
      if (a.confidence < this.policy.minConfidence) continue;
      if (a.sampleSize < this.policy.minSampleSize) continue;
      if (a.shrunkEV < def.shrunkEV + this.policy.minSwitchMarginEV) continue;
      if (a.shrunkEV > best.shrunkEV) best = a;
    }
    const switched = best.target !== DEFAULT_TARGET;
    return {
      selected: best,
      alternatives: assessments.filter((a) => a.target !== best.target),
      switchedFromDefault: switched,
      reason: switched
        ? `Switch to ${best.target}x: shrunkEV ${best.shrunkEV.toFixed(3)} > default ${def.shrunkEV.toFixed(3)} + margin`
        : `Default ${DEFAULT_TARGET}x (no alternative cleared margin/confidence/sample gates)`,
    };
  }
}

export const globalMultiTargetEngine = new MultiTargetEngine();
