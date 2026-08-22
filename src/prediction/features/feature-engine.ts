import { createHash } from 'crypto';
import { HistoricalRound, FeatureVector, FeatureVersion } from '../types.js';
import { computeFeatures } from './calculators.js';
import { getLogger } from '../../observability/logger.js';

export const CURRENT_FEATURE_VERSION: FeatureVersion = 'fv-1.0.0';

export class FeatureEngine {
  private readonly logger = getLogger();
  readonly featureVersion: FeatureVersion;
  constructor(featureVersion: FeatureVersion = CURRENT_FEATURE_VERSION) {
    this.featureVersion = featureVersion;
  }
  buildVector(priorRounds: HistoricalRound[], targetRoundId: string, timestamp: string): FeatureVector {
    const values = computeFeatures(priorRounds, timestamp);
    const missing = Object.values(values).filter((v) => !Number.isFinite(v)).length;
    for (const k of Object.keys(values)) {
      if (!Number.isFinite(values[k])) values[k] = 0;
    }
    return {
      roundId: targetRoundId,
      timestamp,
      featureVersion: this.featureVersion,
      values,
      meta: {
        sampleSize: priorRounds.length,
        dataQualityScore: values.quality_score ?? 0,
        missingFeatureCount: missing,
      },
    };
  }
  buildSequence(rounds: HistoricalRound[], minHistory = 20): FeatureVector[] {
    const vectors: FeatureVector[] = [];
    for (let i = minHistory; i < rounds.length; i++) {
      const prior = rounds.slice(0, i);
      const target = rounds[i];
      const ts = target.startedAt ?? target.crashedAt ?? target.createdAt;
      vectors.push(this.buildVector(prior, target.id, ts));
    }
    this.logger.debug({ component: 'FeatureEngine', total: rounds.length, produced: vectors.length }, 'Built feature sequence');
    return vectors;
  }
  configHash(): string {
    return createHash('sha256')
      .update(`${this.featureVersion}|keys`)
      .digest('hex')
      .slice(0, 16);
  }
}
