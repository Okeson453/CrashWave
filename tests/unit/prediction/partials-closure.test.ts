import { bridgeOpportunityToDecisionRanker } from '@/opportunity/prediction-bridge';
import { OpportunityRanker } from '@/opportunity/ranker';
import { computeGroupImportance, DEFAULT_FEATURE_GROUPS } from '@/prediction/features/feature-importance';
import { featureRowsFromCrashPoints, runRegimeFitJob } from '@/prediction/regimes/regime-fit-job';
import { globalLearnedRegimes } from '@/prediction/regimes/learned-clustering';
import { InMemoryPredictionProvenanceRepository } from '@/persistence/repositories/prediction-provenance-repo';
import type { OpportunityRecord } from '@/prediction/opportunity/opportunity-ranker';

describe('Partials closure', () => {
  it('bridges prediction opportunity into decision ranker', () => {
    const ranker = new OpportunityRanker({ minQualityScore: 0.1 });
    const rec: OpportunityRecord = {
      opportunityId: 'o-1',
      predictionId: 'p-1',
      target: 1.3,
      probability: 0.7,
      calibratedProbability: 0.68,
      expectedValue: 0.08,
      confidence: 0.8,
      score: 0.05,
      rank: 1,
      regime: 'normal',
      modelVersion: 'v1',
      featureVersion: 'fv',
      timestamp: new Date().toISOString(),
      expiry: new Date(Date.now() + 60_000).toISOString(),
    };
    const scored = bridgeOpportunityToDecisionRanker(ranker, rec);
    expect(scored).not.toBeNull();
    expect(ranker.top(1)[0].id).toBe('o-1');
  });

  it('feature group importance ranks lag vs null', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      lag_1: i % 2,
      lag_2: 0,
      lag_3: 0,
      lag_5: 0,
      lag_diff_1: 0,
      lag_ratio_1: 1,
      run_below_13: 0,
      run_above_13: 0,
      run_below_20: 0,
      run_above_20: 0,
      markov_p_hit_13: 0.6,
      markov_p_hit_20: 0.5,
      spectral_energy: 0,
      spectral_flatness_proxy: 1,
      entropy_short: 1,
      entropy_long: 1,
      hour_sin: 0,
      hour_cos: 1,
      dow_sin: 0,
    }));
    const outcomes = rows.map((r) => r.lag_1);
    const results = computeGroupImportance(rows, outcomes, DEFAULT_FEATURE_GROUPS, (f) =>
      Math.min(0.99, Math.max(0.01, 0.5 + 0.3 * (f.lag_1 ?? 0)))
    );
    expect(results[0].group).toBe('lag');
    expect(results[0].delta).toBeGreaterThan(0);
  });

  it('regime fit job fits offline features', () => {
    const pts = Array.from({ length: 300 }, (_, i) => (i % 4 === 0 ? 1.1 : 1.5));
    const { rows, outcomes } = featureRowsFromCrashPoints(pts);
    const model = runRegimeFitJob({ featureRows: rows, outcomes, k: 4 });
    expect(model.k).toBe(4);
    expect(globalLearnedRegimes.isFitted()).toBe(true);
  });

  it('provenance in-memory records full set', async () => {
    const repo = new InMemoryPredictionProvenanceRepository();
    await repo.recordModelScores('p1', [
      { modelName: 'pipeline', modelVersion: '1', probability: 0.6 },
    ]);
    await repo.recordOpportunity({
      opportunityId: 'o1',
      predictionId: 'p1',
      target: 1.3,
      score: 0.02,
    });
    await repo.enrichPrediction({ predictionId: 'p1', calibratedProbability: 0.61 });
    expect(repo.modelScores.length).toBe(1);
    expect(repo.opportunities.length).toBe(1);
  });
});
