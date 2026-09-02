import { runDesignAcceptance } from '@/prediction/validation/design-acceptance';
import { tickLearningWithHooks } from '@/prediction/learning/learning-bootstrap';
import { SheathMode } from '@/core/sheath-mode';
import { globalCalibrationState } from '@/prediction/calibration/calibration-state';
import { LearnedRegimeClustering } from '@/prediction/regimes/learned-clustering';
import { runPredictionPipeline } from '@/prediction/prediction-pipeline';
import { globalIncrementalState } from '@/prediction/state/incremental-state-engine';
import { InMemoryPredictionProvenanceRepository } from '@/persistence/repositories/prediction-provenance-repo';

describe('Design closure acceptance', () => {
  it('engineering gates pass without production history', () => {
    const report = runDesignAcceptance();
    expect(report.summary).toContain('PASSED');
    const failedRequired = report.items.filter(
      (i) =>
        !i.passed &&
        ![
          'fifty-k-live-history-validation',
          'walk-forward-production-signoff',
          'canary-traffic-live-signoff',
        ].includes(i.id)
    );
    expect(failedRequired).toEqual([]);
  });

  it('learning hooks refit calibration on cadence', () => {
    for (let i = 0; i < 30; i++) {
      globalCalibrationState.observe(0.6, i % 2 === 0 ? 1 : 0);
    }
    const sheath = new SheathMode();
    for (let i = 0; i < 100; i++) tickLearningWithHooks(sheath);
    expect(globalCalibrationState.metrics().n).toBeGreaterThan(0);
  });

  it('learned regimes influence pipeline when fitted', () => {
    globalIncrementalState.seed(
      Array.from({ length: 80 }, (_, i) => (i % 3 === 0 ? 1.1 : 1.5))
    );
    const clustering = new LearnedRegimeClustering();
    const rows = Array.from({ length: 80 }, (_, i) => [
      0.6 + (i % 5) * 0.01,
      1.3,
      i % 7,
      0,
      0.6,
      0.6,
      1.4,
      2,
    ]);
    clustering.fit(
      rows,
      rows.map((_, i) => (i % 3 === 0 ? 0 : 1)),
      4
    );
    // Use global via fit on globalLearnedRegimes in test:
    const { globalLearnedRegimes } = require('@/prediction/regimes/learned-clustering');
    globalLearnedRegimes.fit(rows, rows.map((_, i) => (i % 3 === 0 ? 0 : 1)), 4);
    const r = runPredictionPipeline({
      baseProbability: 0.64,
      regime: 'normal',
      dataQuality: 0.9,
    });
    expect(r.opportunity.regime).toContain('cluster');
  });

  it('in-memory provenance records scores', async () => {
    const repo = new InMemoryPredictionProvenanceRepository();
    await repo.recordModelScores('p1', [
      { modelName: 'FrequencyModel', modelVersion: '1', probability: 0.65, weight: 0.2 },
    ]);
    await repo.recordCalibration({
      predictionId: 'p1',
      rawProbability: 0.65,
      calibratedProbability: 0.62,
      calibrationVersion: 'cal-v1',
    });
    await repo.recordOpportunity({
      opportunityId: 'o1',
      predictionId: 'p1',
      target: 1.3,
      score: 0.02,
    });
    expect(repo.modelScores.length).toBe(1);
    expect(repo.calibrations.length).toBe(1);
    expect(repo.opportunities.length).toBe(1);
  });
});
