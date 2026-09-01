import type { IncrementalStateEngine } from '../state/incremental-state-engine.js';
import type { FeatureMeta } from './feature-meta.js';

export const RUN_FEATURE_META: FeatureMeta[] = [
  { featureName: 'run_below_13', featureVersion: '1', source: 'runs', updateCost: 'O(1)', dependencies: [], validityWindow: 1e9, missingValuePolicy: 'zero' },
  { featureName: 'run_above_13', featureVersion: '1', source: 'runs', updateCost: 'O(1)', dependencies: [], validityWindow: 1e9, missingValuePolicy: 'zero' },
  { featureName: 'run_max_below_13', featureVersion: '1', source: 'runs', updateCost: 'O(1)', dependencies: [], validityWindow: 1e9, missingValuePolicy: 'zero' },
  { featureName: 'run_max_above_13', featureVersion: '1', source: 'runs', updateCost: 'O(1)', dependencies: [], validityWindow: 1e9, missingValuePolicy: 'zero' },
];

export function computeRunFeatures(engine: IncrementalStateEngine): Record<string, number> {
  const s = engine.snapshot().runs;
  return {
    run_below_13: s.below13,
    run_above_13: s.above13,
    run_below_15: s.below15,
    run_above_20: s.above20,
    run_max_below_13: s.maxBelow13,
    run_max_above_13: s.maxAbove13,
  };
}
