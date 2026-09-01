/**
 * Lightweight spectral proxies over lag ring (no FFT dependency).
 * Full periodogram stays off critical path; these are O(w) with w≤64.
 */
import type { IncrementalStateEngine } from '../state/incremental-state-engine.js';
import type { FeatureMeta } from './feature-meta.js';

export const SPECTRAL_FEATURE_META: FeatureMeta[] = [
  { featureName: 'spec_energy_low', featureVersion: '1', source: 'lag-ring', updateCost: 'O(w)', dependencies: [], validityWindow: 64, missingValuePolicy: 'zero' },
  { featureName: 'spec_energy_high', featureVersion: '1', source: 'lag-ring', updateCost: 'O(w)', dependencies: [], validityWindow: 64, missingValuePolicy: 'zero' },
  { featureName: 'spec_flatness', featureVersion: '1', source: 'lag-ring', updateCost: 'O(w)', dependencies: [], validityWindow: 64, missingValuePolicy: 'zero' },
];

export function computeSpectralFeatures(engine: IncrementalStateEngine): Record<string, number> {
  const xs = engine.getLagArray();
  const n = xs.length;
  if (n < 8) {
    return { spec_energy_low: 0, spec_energy_high: 0, spec_flatness: 1, spec_acf1: 0 };
  }
  // Mean-center
  let mean = 0;
  for (let i = 0; i < n; i++) mean += xs[i];
  mean /= n;
  // ACF lag-1
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - mean;
    den += d * d;
    if (i > 0) num += d * (xs[i - 1] - mean);
  }
  const acf1 = den > 0 ? num / den : 0;
  // Two-bin spectral energy via simple goertzel-like cosine projection
  let c1 = 0, s1 = 0, c2 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] - mean;
    const a1 = (2 * Math.PI * i) / n;
    const a2 = (4 * Math.PI * i) / n;
    c1 += x * Math.cos(a1);
    s1 += x * Math.sin(a1);
    c2 += x * Math.cos(a2);
    s2 += x * Math.sin(a2);
  }
  const eLow = (c1 * c1 + s1 * s1) / n;
  const eHigh = (c2 * c2 + s2 * s2) / n;
  const total = eLow + eHigh + 1e-9;
  const flatness = Math.exp(0.5 * (Math.log(eLow + 1e-12) + Math.log(eHigh + 1e-12))) / (total / 2);
  return {
    spec_energy_low: eLow,
    spec_energy_high: eHigh,
    spec_flatness: Math.min(1, Math.max(0, flatness)),
    spec_acf1: acf1,
  };
}
