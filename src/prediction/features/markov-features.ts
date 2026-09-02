import type { IncrementalStateEngine } from '../state/incremental-state-engine.js';
import type { FeatureMeta } from './feature-meta.js';

export const MARKOV_FEATURE_META: FeatureMeta[] = [
  { featureName: 'markov_p_above_13', featureVersion: '1', source: 'markov', updateCost: 'O(1)', dependencies: [], validityWindow: 1e9, missingValuePolicy: 'carry' },
  { featureName: 'markov_p_below_13', featureVersion: '1', source: 'markov', updateCost: 'O(1)', dependencies: [], validityWindow: 1e9, missingValuePolicy: 'carry' },
  { featureName: 'markov_support', featureVersion: '1', source: 'markov', updateCost: 'O(1)', dependencies: [], validityWindow: 1e9, missingValuePolicy: 'zero' },
];

export function computeMarkovFeatures(engine: IncrementalStateEngine): Record<string, number> {
  const m = engine.snapshot().markov;
  const from = m.lastAbove13 === null ? -1 : m.lastAbove13 ? 1 : 0;
  let support = 0;
  let pAbove = engine.markovPNextAbove13();
  if (from >= 0) {
    const row = m.trans[from as 0 | 1];
    support = row[0] + row[1];
  }
  return {
    markov_p_above_13: pAbove,
    markov_p_below_13: 1 - pAbove,
    markov_support: support,
    markov_from_above: from === 1 ? 1 : 0,
  };
}
