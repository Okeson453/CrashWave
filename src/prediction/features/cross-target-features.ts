import type { IncrementalStateEngine } from '../state/incremental-state-engine.js';
import type { FeatureMeta } from './feature-meta.js';

export const CROSS_TARGET_FEATURE_META: FeatureMeta[] = [
  { featureName: 'hit_ratio_20_13', featureVersion: '1', source: 'hits', updateCost: 'O(1)', dependencies: [], validityWindow: 1e9, missingValuePolicy: 'zero' },
  { featureName: 'hit_ratio_50_13', featureVersion: '1', source: 'hits', updateCost: 'O(1)', dependencies: [], validityWindow: 1e9, missingValuePolicy: 'zero' },
];

export function computeCrossTargetFeatures(engine: IncrementalStateEngine): Record<string, number> {
  const h13 = engine.hitRate(1.3);
  const h20 = engine.hitRate(2.0);
  const h50 = engine.hitRate(5.0);
  return {
    hit_13: h13,
    hit_20: h20,
    hit_50: h50,
    hit_ratio_20_13: h13 > 1e-6 ? h20 / h13 : 0,
    hit_ratio_50_13: h13 > 1e-6 ? h50 / h13 : 0,
    hit_spread_20_13: h13 - h20,
  };
}
