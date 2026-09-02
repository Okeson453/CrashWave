import type { FeatureMeta } from './feature-meta.js';

export const TIME_FEATURE_META: FeatureMeta[] = [
  { featureName: 'hour_sin', featureVersion: '1', source: 'clock', updateCost: 'O(1)', dependencies: [], validityWindow: 1, missingValuePolicy: 'zero' },
  { featureName: 'hour_cos', featureVersion: '1', source: 'clock', updateCost: 'O(1)', dependencies: [], validityWindow: 1, missingValuePolicy: 'zero' },
  { featureName: 'dow_sin', featureVersion: '1', source: 'clock', updateCost: 'O(1)', dependencies: [], validityWindow: 1, missingValuePolicy: 'zero' },
  { featureName: 'dow_cos', featureVersion: '1', source: 'clock', updateCost: 'O(1)', dependencies: [], validityWindow: 1, missingValuePolicy: 'zero' },
];

export function computeTimeFeatures(at: Date = new Date()): Record<string, number> {
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  const dow = at.getUTCDay();
  return {
    hour_sin: Math.sin((2 * Math.PI * hour) / 24),
    hour_cos: Math.cos((2 * Math.PI * hour) / 24),
    dow_sin: Math.sin((2 * Math.PI * dow) / 7),
    dow_cos: Math.cos((2 * Math.PI * dow) / 7),
    hour_utc: hour,
    is_weekend: dow === 0 || dow === 6 ? 1 : 0,
  };
}
