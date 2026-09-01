/**
 * Feature Engine v2 — assembles incremental + feature families.
 * Critical path uses IncrementalStateEngine only (no full history scan).
 */

import { createHash } from 'crypto';
import type { FeatureVector, HistoricalRound } from '../types.js';
import {
  IncrementalStateEngine,
  globalIncrementalState,
} from '../state/incremental-state-engine.js';
import { FEATURE_VERSION_V2, CURRENT_FEATURE_VERSION } from './feature-meta.js';
import { computeLagFeatures } from './lag-features.js';
import { computeRunFeatures } from './run-features.js';
import { computeMarkovFeatures } from './markov-features.js';
import { computeSpectralFeatures } from './spectral-features.js';
import { computeEntropyFeatures } from './entropy-features.js';
import { computeTimeFeatures } from './time-features.js';
import { computeCrossTargetFeatures } from './cross-target-features.js';
import { computeFeatures as computeLegacy } from './calculators.js';

export class FeatureEngineV2 {
  readonly featureVersion = FEATURE_VERSION_V2;

  constructor(private readonly engine: IncrementalStateEngine = globalIncrementalState) {}

  /** O(1) snapshot from incremental state (critical path). */
  snapshotFromState(
    targetRoundId: string,
    timestamp: string = new Date().toISOString()
  ): FeatureVector {
    const values: Record<string, number> = {
      ...this.baseFromEngine(),
      ...computeLagFeatures(this.engine),
      ...computeRunFeatures(this.engine),
      ...computeMarkovFeatures(this.engine),
      ...computeSpectralFeatures(this.engine),
      ...computeEntropyFeatures(this.engine),
      ...computeTimeFeatures(new Date(timestamp)),
      ...computeCrossTargetFeatures(this.engine),
    };
    for (const k of Object.keys(values)) {
      if (!Number.isFinite(values[k])) values[k] = 0;
    }
    const snap = this.engine.snapshot();
    return {
      roundId: targetRoundId,
      timestamp,
      featureVersion: this.featureVersion,
      values,
      meta: {
        sampleSize: snap.count,
        dataQualityScore: Math.min(1, snap.count / 100),
        missingFeatureCount: 0,
      },
    };
  }

  /** Offline / validation path: rebuild engine from prior rounds then snapshot. */
  buildVector(
    priorRounds: HistoricalRound[],
    targetRoundId: string,
    timestamp: string
  ): FeatureVector {
    const local = new IncrementalStateEngine();
    local.seed(priorRounds.map((r) => r.crashPoint));
    const tmp = new FeatureEngineV2(local);
    return tmp.snapshotFromState(targetRoundId, timestamp);
  }

  /** Legacy full recompute for backtests that need identical fv-1 keys */
  buildLegacyVector(
    priorRounds: HistoricalRound[],
    targetRoundId: string,
    timestamp: string
  ): FeatureVector {
    const values = computeLegacy(priorRounds, timestamp);
    for (const k of Object.keys(values)) {
      if (!Number.isFinite(values[k])) values[k] = 0;
    }
    return {
      roundId: targetRoundId,
      timestamp,
      featureVersion: CURRENT_FEATURE_VERSION,
      values,
      meta: {
        sampleSize: priorRounds.length,
        dataQualityScore: values.quality_score ?? 0,
        missingFeatureCount: 0,
      },
    };
  }

  featureHash(values: Record<string, number>): string {
    const keys = Object.keys(values).sort();
    const payload = keys.map((k) => `${k}=${values[k]}`).join('|');
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }

  private baseFromEngine(): Record<string, number> {
    const e = this.engine;
    const s = e.snapshot();
    const variance = e.variance();
    return {
      n: s.count,
      mean_cp: s.welford.mean,
      var_cp: variance,
      std_cp: Math.sqrt(variance),
      last_cp: s.lastCrash ?? 0,
      ewma_cp: s.ewma,
      ewma_hit_13: s.ewmaHit13,
      short_mean: e.shortMean(),
      short_var: e.shortVariance(),
      short_hit_13: e.shortHitRate13(),
      quality_score: Math.min(1, s.count / 100),
    };
  }
}

export const globalFeatureEngineV2 = new FeatureEngineV2();
