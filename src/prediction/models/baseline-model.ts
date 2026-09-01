/**
 * Baseline statistical / heuristic model (NOT machine learning).
 * Uses empirical conditional rates from features — deterministic, train-free.
 */

import { CURRENT_FEATURE_VERSION } from '../features/feature-meta.js';
import { FeatureVector, ThresholdTarget, ModelIdentity, PredictionOutput, Regime, Dataset } from '../types.js';
import { randomUUID } from 'crypto';

/**
 * Model capability contract.
 * Baseline models may no-op fit(); trainable models implement fit().
 */
export interface PredictiveModel {
  readonly identity: ModelIdentity;
  /** Optional training step. Baseline statistical models leave this as no-op. */
  fit?(trainingData: Dataset): void | Promise<void>;
  predict(
    features: FeatureVector,
    target: ThresholdTarget,
    regime: Regime | null
  ): PredictionOutput;
}

/**
 * Deterministic statistical baseline — explicitly NOT a trained ML model.
 */
export class BaselineStatisticalModel implements PredictiveModel {
  readonly identity: ModelIdentity = {
    name: 'baseline-statistical',
    version: '1.0.0',
    featureVersion: CURRENT_FEATURE_VERSION,
    targetVersion: 'tv-1.0.0',
  };

  /** Baseline is train-free; fit is a no-op for interface compatibility. */
  fit(_trainingData: Dataset): void {
    // intentionally empty — heuristic does not learn parameters from training rows
  }

  predict(
    features: FeatureVector,
    target: ThresholdTarget,
    regime: Regime | null
  ): PredictionOutput {
    const v = features.values;
    const targetKey =
      target === 1.3 ? '1_30' : target === 2.0 ? '2_00' : target === 5.0 ? '5_00' : '10_00';

    let baseProb = v[`hit_${targetKey}_50`] ?? 0.3;
    const longProb = v[`hit_${targetKey}_100`] ?? baseProb;
    baseProb = 0.7 * baseProb + 0.3 * longProb;

    const since = v[`since_${targetKey}`] ?? 0;
    const expectedGap = 1 / Math.max(baseProb, 0.05);
    if (since > expectedGap * 1.5) {
      baseProb = Math.min(0.95, baseProb * 1.15);
    }

    const consecKey = target <= 1.3 ? 'consec_below_1_30' : 'consec_below_2_00';
    if ((v[consecKey] ?? 0) >= 8) {
      baseProb = Math.min(0.95, baseProb * 1.1);
    }

    if (regime?.dimensions.anomalyState) {
      baseProb *= 0.7;
    }

    const probability = Math.max(0, Math.min(1, baseProb));
    const sampleFactor = Math.min(1, (v.sample_size ?? 0) / 50);
    const quality = features.meta.dataQualityScore;
    const confidence = Math.max(
      0,
      Math.min(1, 0.4 * sampleFactor + 0.4 * quality + 0.2 * (regime?.confidence ?? 0.5))
    );

    const reasoning: string[] = [
      `Baseline statistical heuristic (not ML)`,
      `Base hit-rate (50): ${((v[`hit_${targetKey}_50`] ?? 0) * 100).toFixed(1)}%`,
      `Rounds since last ≥${target}x: ${since}`,
      `Sample size: ${v.sample_size ?? 0}`,
    ];
    if (regime) reasoning.push(`Regime: ${regime.name}`);

    const now = new Date();
    return {
      predictionId: randomUUID(),
      model: this.identity,
      target,
      score: probability,
      probability,
      confidence,
      regime,
      dataQuality: quality,
      featureSummary: {
        hit_rate_50: v[`hit_${targetKey}_50`] ?? 0,
        since,
        sample_size: v.sample_size ?? 0,
        roll_mean_50: v.roll_mean_50 ?? 0,
      },
      reasoning,
      timestamp: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    };
  }
}
