import { SheathMode } from '@/core/sheath-mode';
import { globalProductionController } from '@/prediction/lifecycle/production-controller';
import { runPredictionPipeline } from '@/prediction/prediction-pipeline';
import { globalIncrementalState } from '@/prediction/state/incremental-state-engine';
import { LearningScheduler } from '@/prediction/learning/learning-scheduler';
import { buildPredictionGeneratedEvent } from '@/prediction/events/prediction-event';

describe('Partials integration — pipeline + sheath + warm + events', () => {
  it('runPredictionPipeline enriches decision fields for live path', () => {
    globalIncrementalState.seed(
      Array.from({ length: 100 }, (_, i) => (i % 4 === 0 ? 1.1 : 1.5))
    );
    const result = runPredictionPipeline({
      baseProbability: 0.64,
      regime: 'normal',
      dataQuality: 0.9,
      bankroll: 50_000,
      baseThreshold: 0.58,
    });
    expect(result.metaProbability).toBeGreaterThan(0);
    expect(result.opportunity.score).toBeGreaterThanOrEqual(0);
    expect(result.targetSelection.selected.target).toBeGreaterThan(0);
    expect(result.threshold).toBeGreaterThanOrEqual(0.5);
  });

  it('sheath reportPredictionHealth escalates on critical divergence', () => {
    const sheath = new SheathMode();
    sheath.reportPredictionHealth({
      divergenceLevel: 5,
      ece: 0.15,
      reason: 'test-critical',
    });
    expect(sheath.isBettingSuspended() || sheath.isPredictionEntriesBlocked()).toBe(true);
  });

  it('cold state blocks prediction entries via sheath flag', () => {
    const sheath = new SheathMode();
    sheath.reportPredictionHealth({ divergenceLevel: 0, coldState: true });
    expect(sheath.isPredictionEntriesBlocked()).toBe(true);
  });

  it('production controller status exposes entry gates', () => {
    const st = globalProductionController.status();
    expect(typeof st.entriesAllowed).toBe('boolean');
    expect(typeof st.kellyAllowed).toBe('boolean');
    expect(st.divergence).toBeDefined();
  });

  it('learning scheduler fires cadence hooks', () => {
    let cal = 0;
    let drift = 0;
    const s = new LearningScheduler(
      {
        onCalibrationReview: () => {
          cal += 1;
        },
        onDriftCheck: () => {
          drift += 1;
        },
      },
      { calibration: 10, featureImportance: 20, walkForward: 50, drift: 5 }
    );
    for (let i = 0; i < 20; i++) s.tick();
    expect(drift).toBe(4);
    expect(cal).toBe(2);
  });

  it('prediction event contract includes required fields', () => {
    const ev = buildPredictionGeneratedEvent({
      predictionId: 'p1',
      roundId: 'r1',
      tenantId: null,
      modelVersion: 'acie-v3',
      featureVersion: 'fv-2.0.0',
      regimeVersion: 'normal',
      calibrationVersion: 'cal-v1',
      target: 1.3,
      rawProbability: 0.64,
      calibratedProbability: 0.62,
      confidence: 0.7,
      expectedValue: 0.05,
      featureHash: 'abc',
      timestamp: new Date().toISOString(),
      latencyMs: 2,
      action: 'ENTRY',
    });
    expect(ev.predictionId).toBe('p1');
    expect(ev.calibratedProbability).toBe(0.62);
  });
});
