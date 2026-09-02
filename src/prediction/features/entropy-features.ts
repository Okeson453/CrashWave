import type { IncrementalStateEngine } from '../state/incremental-state-engine.js';
import type { FeatureMeta } from './feature-meta.js';

export const ENTROPY_FEATURE_META: FeatureMeta[] = [
  { featureName: 'entropy_binary_13', featureVersion: '1', source: 'hits', updateCost: 'O(1)', dependencies: [], validityWindow: 1e9, missingValuePolicy: 'zero' },
  { featureName: 'entropy_short_13', featureVersion: '1', source: 'short-window', updateCost: 'O(1)', dependencies: [], validityWindow: 30, missingValuePolicy: 'zero' },
];

function binaryEntropy(p: number): number {
  const q = Math.min(0.999, Math.max(0.001, p));
  return -(q * Math.log2(q) + (1 - q) * Math.log2(1 - q));
}

export function computeEntropyFeatures(engine: IncrementalStateEngine): Record<string, number> {
  const p = engine.hitRate(1.3);
  const ps = engine.shortHitRate13();
  return {
    entropy_binary_13: binaryEntropy(p),
    entropy_short_13: binaryEntropy(ps),
    entropy_ratio: binaryEntropy(ps) / (binaryEntropy(p) + 1e-9),
  };
}
