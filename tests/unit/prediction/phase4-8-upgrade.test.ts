import { MetaLogisticModel } from '@/prediction/models/meta-logistic-model';
import { MultiTargetEngine } from '@/prediction/multi-target/multi-target-engine';
import { computeOpportunityScore } from '@/prediction/opportunity/opportunity-score';
import { OpportunityRanker } from '@/prediction/opportunity/opportunity-ranker';
import { computeDynamicThreshold } from '@/prediction/strategy/dynamic-threshold';
import { fractionalKellyStake } from '@/prediction/stake/kelly-sizer';
import { LiveDivergenceMonitor } from '@/prediction/validation/live-divergence-monitor';
import { FeatureDriftMonitor } from '@/prediction/drift/feature-drift';
import { ConceptDriftMonitor } from '@/prediction/drift/concept-drift';
import { ModelLifecycleManager } from '@/prediction/lifecycle/model-lifecycle';
import { ProductionController } from '@/prediction/lifecycle/production-controller';
import { globalIncrementalState } from '@/prediction/state/incremental-state-engine';
import { runPredictionPipeline, feedbackPredictionPipeline } from '@/prediction/prediction-pipeline';
import { CalibrationState } from '@/prediction/calibration/calibration-state';

describe('Phase 5 — Meta logistic model', () => {
  it('predicts in (0,1) and learns from outcomes', () => {
    const m = new MetaLogisticModel();
    const f = {
      baseProbability: 0.66,
      disagreement: 0.05,
      regimeConfidence: 0.7,
      dataQuality: 0.8,
      sampleCount: 200,
      recentLogLoss: 0.5,
      recentBrier: 0.2,
      ece: 0.04,
      shortHitRate: 0.64,
      markovP: 0.63,
    };
    const p0 = m.predict(f);
    expect(p0).toBeGreaterThan(0.01);
    expect(p0).toBeLessThan(0.99);
    for (let i = 0; i < 60; i++) {
      m.observe(f, i % 3 === 0 ? 0 : 1);
    }
    expect(m.isFitted()).toBe(true);
  });
});

describe('Phase 6 — Multi-target, opportunity, threshold, Kelly', () => {
  it('does not switch target without margin and sample', () => {
    const eng = new MultiTargetEngine();
    const assessments = eng.assess({
      probabilities: { 1.3: 0.65, 2.0: 0.4, 5.0: 0.15 },
      calibrated: { 1.3: 0.64, 2.0: 0.38, 5.0: 0.14 },
      confidence: 0.7,
      sampleSize: 200,
      historicalHitRates: { 1.3: 0.65, 2.0: 0.4, 5.0: 0.15 },
    });
    const sel = eng.select(assessments);
    expect(sel.selected.target).toBe(1.3);
    expect(sel.switchedFromDefault).toBe(false);
  });

  it('ranks opportunities without inventing probability', () => {
    const score = computeOpportunityScore({
      calibratedEdge: 0.08,
      confidence: 0.7,
      dataQuality: 0.9,
      regimeStability: 0.8,
      modelAgreement: 0.75,
      executionQuality: 0.95,
    });
    expect(score).toBeGreaterThan(0);
    const ranker = new OpportunityRanker(50);
    const a = ranker.scoreAndInsert({
      predictionId: 'p1',
      target: 1.3,
      probability: 0.66,
      calibratedProbability: 0.64,
      expectedValue: 0.05,
      confidence: 0.7,
      regime: 'normal',
      modelVersion: 't',
      featureVersion: 'fv',
      inputs: {
        calibratedEdge: 0.08,
        confidence: 0.7,
        dataQuality: 0.9,
        regimeStability: 0.8,
        modelAgreement: 0.75,
        executionQuality: 0.95,
      },
    });
    expect(a.rank).toBe(1);
  });

  it('dynamic threshold never goes below 0.5+ECE floor and ignores volume', () => {
    const r = computeDynamicThreshold({
      baseThreshold: 0.58,
      ece: 0.04,
      realizedVsExpected: 0,
      regime: 'normal',
      sampleConfidence: 0.8,
      dataQuality: 0.9,
      modelAgreement: 0.8,
    });
    expect(r.threshold).toBeGreaterThanOrEqual(0.5 + 0.04);
    // volume not a field — cannot drive threshold
  });

  it('Kelly uses calibrated p and returns 0 when no edge', () => {
    const noEdge = fractionalKellyStake({
      calibratedProbability: 0.4,
      target: 1.3,
      bankroll: 100_000,
      sampleConfidence: 1,
      calibrationConfidence: 1,
      evidenceQuality: 1,
      modelAgreement: 1,
      drawdownPressure: 0,
    });
    expect(noEdge.stake).toBe(0);
    const edge = fractionalKellyStake({
      calibratedProbability: 0.8,
      target: 1.3,
      bankroll: 100_000,
      sampleConfidence: 1,
      calibrationConfidence: 1,
      evidenceQuality: 1,
      modelAgreement: 1,
      drawdownPressure: 0,
    });
    expect(edge.stake).toBeGreaterThan(0);
    expect(edge.appliedFraction).toBeLessThanOrEqual(0.05);
  });
});

describe('Phase 7 — Divergence, drift, lifecycle', () => {
  it('escalates divergence and requires manual recovery', () => {
    const mon = new LiveDivergenceMonitor(500);
    // Over-predict systematically
    for (let i = 0; i < 200; i++) {
      mon.observe(0.85, 0);
    }
    expect(mon.getLevel()).toBeGreaterThanOrEqual(3);
    expect(mon.getActions().fullSheathHaltEntries || mon.getActions().lockConservativeBaseline).toBe(
      true
    );
    const snap = mon.manualRecover(true);
    expect(snap.manualRecoveryRequired).toBe(false);
  });

  it('detects feature and concept drift', () => {
    const fd = new FeatureDriftMonitor(0.1, 0.2);
    fd.setBaseline({ a: 1, b: 2 });
    for (let i = 0; i < 120; i++) fd.observe({ a: 3, b: 5 });
    expect(fd.observe({ a: 3, b: 5 }).drifted).toBe(true);

    const cd = new ConceptDriftMonitor(20, 40);
    for (let i = 0; i < 40; i++) cd.observe(0.6, 1);
    for (let i = 0; i < 25; i++) cd.observe(0.9, 0);
    expect(cd.observe(0.9, 0).detected).toBe(true);
  });

  it('lifecycle promotion gates and canary routing', () => {
    const life = new ModelLifecycleManager();
    life.register({
      modelName: 'baseline',
      modelVersion: '1',
      stage: 'PRODUCTION',
      trafficShare: 1,
      metrics: { brier: 0.22, logLoss: 0.55, ece: 0.04, oosSkill: 0.01 },
    });
    life.register({
      modelName: 'meta',
      modelVersion: '2',
      stage: 'VALIDATION',
      trafficShare: 0,
      metrics: { brier: 0.2, logLoss: 0.5, ece: 0.03, oosSkill: 0.03 },
    });
    const gate = life.checkPromotionGates(
      life.get('meta', '2')!,
      life.get('baseline', '1')!
    );
    expect(gate.allowed).toBe(true);
    life.promote('meta', '2', 'SHADOW');
    life.promote('meta', '2', 'CANARY');
    expect(life.get('meta', '2')!.trafficShare).toBe(0.05);
    let hits = 0;
    for (let i = 0; i < 1000; i++) {
      if (life.routeCanary('meta', '2', i / 1000)) hits++;
    }
    expect(hits).toBeGreaterThan(30);
    expect(hits).toBeLessThan(100);
  });
});

describe('Phase 8 — Production controller + pipeline', () => {
  it('canary advance and rollback', () => {
    const life = new ModelLifecycleManager();
    const div = new LiveDivergenceMonitor(100);
    const ctrl = new ProductionController(life, div);
    life.register({
      modelName: 'prod',
      modelVersion: '1',
      stage: 'PRODUCTION',
      trafficShare: 1,
      metrics: {},
    });
    life.register({
      modelName: 'cand',
      modelVersion: '2',
      stage: 'SHADOW',
      trafficShare: 0,
      metrics: {},
    });
    ctrl.advanceCanary('cand', '2');
    expect(life.get('cand', '2')!.stage).toBe('CANARY');
    ctrl.advanceCanary('cand', '2'); // 25%
    expect(life.get('cand', '2')!.trafficShare).toBe(0.25);
    ctrl.rollback('prod', '1');
    expect(life.get('prod', '1')!.stage).toBe('PRODUCTION');
  });

  it('runPredictionPipeline returns structured result', () => {
    globalIncrementalState.seed(
      Array.from({ length: 120 }, (_, i) => (i % 4 === 0 ? 1.1 : 1.5))
    );
    const result = runPredictionPipeline({
      baseProbability: 0.64,
      regime: 'normal',
      regimeConfidence: 0.7,
      dataQuality: 0.85,
      bankroll: 50_000,
      baseThreshold: 0.58,
    });
    expect(result.calibratedProbability).toBeGreaterThan(0.01);
    expect(result.opportunity.opportunityId).toBeTruthy();
    expect(['ENTRY', 'REDUCED_ENTRY', 'SKIP']).toContain(result.action);
    feedbackPredictionPipeline(result.calibratedProbability, 1);
  });
});

describe('Phase 4 reinforcement — calibration still works', () => {
  it('ECE tracked after batch observes', () => {
    const cal = new CalibrationState();
    for (let i = 0; i < 100; i++) {
      cal.observe(0.6, i % 2 === 0 ? 1 : 0);
    }
    cal.refit();
    expect(cal.metrics().n).toBe(100);
    expect(cal.isWarm()).toBe(true);
  });
});
