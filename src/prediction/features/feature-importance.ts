
/**
 * Lightweight leave-one-group-out importance proxy on historical binary outcomes.
 * Not full SHAP — OOS delta in Brier when zeroing a feature group.
 */

export interface FeatureImportanceResult {
  group: string;
  baselineBrier: number;
  ablatedBrier: number;
  delta: number;
}

function brier(probs: number[], ys: number[]): number {
  let s = 0;
  const n = Math.min(probs.length, ys.length);
  if (n === 0) return 0;
  for (let i = 0; i < n; i++) s += (probs[i] - ys[i]) ** 2;
  return s / n;
}

/**
 * groups: map group name → list of feature keys
 * rows: feature maps aligned with binary outcomes
 * scoreFn: maps feature map → probability
 */
export function computeGroupImportance(
  rows: Array<Record<string, number>>,
  outcomes: number[],
  groups: Record<string, string[]>,
  scoreFn: (features: Record<string, number>) => number
): FeatureImportanceResult[] {
  const baselineProbs = rows.map((r) => scoreFn(r));
  const baselineBrier = brier(baselineProbs, outcomes);
  const results: FeatureImportanceResult[] = [];
  for (const [group, keys] of Object.entries(groups)) {
    const ablated = rows.map((r) => {
      const copy = { ...r };
      for (const k of keys) copy[k] = 0;
      return scoreFn(copy);
    });
    const ablatedBrier = brier(ablated, outcomes);
    results.push({
      group,
      baselineBrier,
      ablatedBrier,
      delta: ablatedBrier - baselineBrier, // positive = group helps
    });
  }
  return results.sort((a, b) => b.delta - a.delta);
}

export const DEFAULT_FEATURE_GROUPS: Record<string, string[]> = {
  lag: ["lag_1", "lag_2", "lag_3", "lag_5", "lag_diff_1", "lag_ratio_1"],
  run: ["run_below_13", "run_above_13", "run_below_20", "run_above_20"],
  markov: ["markov_p_hit_13", "markov_p_hit_20"],
  spectral: ["spectral_energy", "spectral_flatness_proxy"],
  entropy: ["entropy_short", "entropy_long"],
  time: ["hour_sin", "hour_cos", "dow_sin"],
};
