/**
 * Candidate sequence models — disabled by default until randomness gate passes.
 * Probabilities are derived from observed state only (no hard-coded edge claims).
 */

import type { IncrementalStateEngine } from '../state/incremental-state-engine.js';

export interface CandidateEstimate {
  modelName: string;
  probability: number;
}

function clamp01(x: number): number {
  return Math.max(0.01, Math.min(0.99, x));
}

/** Lag-1 autocorrelation adjusted frequency */
export function autocorrelationModel(engine: IncrementalStateEngine): CandidateEstimate {
  const baseline = engine.snapshot().ewmaHit13;
  const lags = engine.getLagArray();
  const n = lags.length;
  if (n < 16) return { modelName: 'AutocorrelationModel', probability: clamp01(baseline) };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += lags[i] >= 1.3 ? 1 : 0;
  mean /= n;
  let num = 0;
  let den = 0;
  for (let i = 1; i < n; i++) {
    const a = (lags[i] >= 1.3 ? 1 : 0) - mean;
    const b = (lags[i - 1] >= 1.3 ? 1 : 0) - mean;
    num += a * b;
    den += b * b;
  }
  const acf = den > 1e-9 ? num / den : 0;
  const last = lags[n - 1] >= 1.3 ? 1 : 0;
  // Mild adjustment from lag-1 dependence (not a hard-coded edge)
  const adj = baseline + acf * (last - baseline) * 0.15;
  return { modelName: 'AutocorrelationModel', probability: clamp01(adj) };
}

export function markovChainModel(engine: IncrementalStateEngine): CandidateEstimate {
  return {
    modelName: 'MarkovChainModel',
    probability: clamp01(engine.markovPNextAbove13()),
  };
}

export function spectralModel(engine: IncrementalStateEngine): CandidateEstimate {
  const baseline = engine.snapshot().ewmaHit13;
  const lags = engine.getLagArray();
  if (lags.length < 16) {
    return { modelName: 'SpectralModel', probability: clamp01(baseline) };
  }
  // Flat spectrum → closer to baseline; strong low-freq → slight move toward short rate
  let mean = 0;
  for (const x of lags) mean += x;
  mean /= lags.length;
  let energy = 0;
  for (const x of lags) energy += (x - mean) ** 2;
  const short = engine.shortHitRate13();
  const mix = Math.min(0.2, energy / (lags.length * 50 + 1e-9));
  return {
    modelName: 'SpectralModel',
    probability: clamp01((1 - mix) * baseline + mix * short),
  };
}

export function entropyModel(engine: IncrementalStateEngine): CandidateEstimate {
  const baseline = engine.snapshot().ewmaHit13;
  const p = engine.shortHitRate13();
  // High entropy (p near 0.5) → trust baseline more; low entropy → trust short window more
  const q = Math.min(0.999, Math.max(0.001, p));
  const entropy = -(q * Math.log2(q) + (1 - q) * Math.log2(1 - q));
  const maxH = 1;
  const certainty = 1 - entropy / maxH;
  return {
    modelName: 'EntropyModel',
    probability: clamp01((1 - certainty * 0.3) * baseline + certainty * 0.3 * p),
  };
}

export function scoreCandidates(engine: IncrementalStateEngine): CandidateEstimate[] {
  return [
    autocorrelationModel(engine),
    markovChainModel(engine),
    spectralModel(engine),
    entropyModel(engine),
  ];
}
