import type { ModelPerf } from './model-performance.js';

/**
 * weight_i = base × recentPerformance × sampleConfidence
 * Uses inverse EWMA log-loss as performance score.
 */
export function computePerformanceWeights(
  modelNames: string[],
  baseWeights: Record<string, number>,
  perf: Map<string, ModelPerf>,
  regimeFit: Record<string, number> = {}
): number[] {
  const raw: number[] = [];
  for (const name of modelNames) {
    const base = baseWeights[name] ?? 1 / modelNames.length;
    const p = perf.get(name);
    let score = 1;
    if (p && p.count >= 20) {
      // Lower log-loss → higher weight
      score = 1 / (0.05 + p.ewmaLogLoss);
      const sampleConf = Math.min(1, p.count / 100);
      score = sampleConf * score + (1 - sampleConf) * 1;
    }
    const regime = regimeFit[name] ?? 1;
    raw.push(Math.max(0, base * score * regime));
  }
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map((w) => w / sum);
}

/** Suppress models that persistently underperform baseline */
export function applySuppression(
  names: string[],
  weights: number[],
  perf: Map<string, ModelPerf>,
  baselineLogLoss: number
): number[] {
  const out = [...weights];
  for (let i = 0; i < names.length; i++) {
    const p = perf.get(names[i]);
    if (p && p.count >= 100 && p.ewmaLogLoss > baselineLogLoss * 1.25) {
      out[i] = 0;
    }
  }
  const sum = out.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights;
  return out.map((w) => w / sum);
}
