/** Feature declaration contract (design §6) */
export interface FeatureMeta {
  featureName: string;
  featureVersion: string;
  source: string;
  updateCost: 'O(1)' | 'O(w)' | 'O(n)';
  dependencies: string[];
  validityWindow: number;
  missingValuePolicy: 'zero' | 'carry' | 'skip';
}

export const FEATURE_VERSION_V2 = 'fv-2.0.0';


export const CURRENT_FEATURE_VERSION = FEATURE_VERSION_V2;

/** Known feature keys for schema validation (subset — expand as needed) */
export const FEATURE_SCHEMA_V2: ReadonlySet<string> = new Set([
  'quality_score',
  'sample_size',
  'hit_1_30_50',
  'hit_1_30_100',
  'hit_1_30_200',
  'mean_crash',
  'std_crash',
  'ewma_crash',
  'run_below_1_30',
  'run_above_1_30',
  'markov_p_up',
  'entropy_short',
  'hour_of_day',
  'day_of_week',
]);
