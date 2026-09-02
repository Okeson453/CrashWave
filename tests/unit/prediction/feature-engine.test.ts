import { FeatureEngine } from '../../../src/prediction/features/feature-engine';
import { LabelGenerator } from '../../../src/prediction/labels/label-generator';
import { DatasetBuilder } from '../../../src/prediction/datasets/dataset-builder';
import { PredictionEngine } from '../../../src/prediction/prediction-engine';
import { StatisticalValidator } from '../../../src/prediction/validation/statistical-validator';
import { BacktestEngine } from '../../../src/prediction/backtesting/backtest-engine';
import { BaselineStatisticalModel } from '../../../src/prediction/models/baseline-model';
import { EntryDecisionService } from '../../../src/prediction/entry-decision-service';
import { HistoricalRound } from '../../../src/prediction/types';
import { InMemoryRoundRepository } from '../../../src/persistence/repositories/round-repo';
import { InMemoryPredictionRepository } from '../../../src/persistence/repositories/prediction-repo';
import { RiskEngine } from '../../../src/betting/risk-engine';
import { RiskEvaluationInput } from '../../../src/betting/types';
import { HistoricalDataService } from '../../../src/prediction/historical-data-service';
import { RollingHistoryBuffer } from '../../../src/prediction/rolling-history-buffer';

function makeRounds(n: number): HistoricalRound[] {
  const rounds: HistoricalRound[] = [];
  let t = Date.now() - n * 60_000;
  for (let i = 0; i < n; i++) {
    const cp = i % 7 === 0 ? 5.2 : i % 3 === 0 ? 2.1 : 1.15;
    rounds.push({
      id: `r-${i}`,
      externalRoundId: `ext-${i}`,
      sessionId: 's1',
      startedAt: new Date(t).toISOString(),
      crashedAt: new Date(t + 10_000).toISOString(),
      crashPoint: cp,
      observationSource: 'websocket',
      dataQuality: 'high',
      createdAt: new Date(t).toISOString(),
      sequenceIndex: i,
    });
    t += 60_000;
  }
  return rounds;
}

function baseRiskInput(): RiskEvaluationInput {
  return {
    mode: 'dry-run',
    operatorAuthorized: true,
    sessionAuthenticated: true,
    gameLoaded: true,
    roundState: {
      roundId: 'r-next',
      phase: 'starting',
      confidence: 'high',
      multiplier: 1,
      startedAt: new Date().toISOString(),
    } as any,
    currentBalance: 50_000,
    dailyEntriesConfirmed: 0,
    paused: false,
    killSwitch: false,
    browserHealthy: true,
    gameAdapterHealthy: true,
    openBetExists: false,
    cooldownElapsed: true,
    requiredStake: 700,
    balanceBuffer: 0,
    maxDailyEntries: 100,
    minConfidenceForEntry: 'high',
    consecutiveErrors: 0,
    maxConsecutiveErrors: 5,
    cashOutFailures: 0,
    maxCashOutFailures: 3,
    minPredictionProbability: 0,
    minPredictionConfidence: 0,
  };
}

describe('Prediction pipeline', () => {
  const rounds = makeRounds(80);

  it('builds leakage-safe features', () => {
    const engine = new FeatureEngine();
    const vectors = engine.buildSequence(rounds, 20);
    expect(vectors.length).toBe(60);
    expect(vectors[0].meta.sampleSize).toBe(20);
  });

  it('generates labels for thresholds', () => {
    const gen = new LabelGenerator();
    const label = gen.generate(rounds[10]);
    expect(label.thresholds['1.30']).toBeDefined();
    expect([0, 1]).toContain(label.thresholds['1.30']);
  });

  it('builds dataset with leakage check', () => {
    const builder = new DatasetBuilder();
    const ds = builder.build(rounds, { minHistory: 20 });
    expect(ds.meta.leakageCheckPassed).toBe(true);
    expect(ds.meta.sampleCount).toBeGreaterThan(0);
  });

  it('produces a prediction signal', () => {
    const eng = new PredictionEngine();
    const prior = rounds.slice(0, 50);
    const signal = eng.predict({
      priorRounds: prior,
      targetRoundId: 'next',
      timestamp: new Date().toISOString(),
      target: 1.3,
    });
    expect(signal.probability).toBeGreaterThanOrEqual(0);
    expect(signal.probability).toBeLessThanOrEqual(1);
    expect(signal.modelVersion).toContain('baseline-statistical');
  });

  it('computes Brier score and ECE without signed cancel', () => {
    const builder = new DatasetBuilder();
    const ds = builder.build(rounds, { minHistory: 20 });
    const model = new BaselineStatisticalModel();
    const scores = ds.rows.map((r) => model.predict(r.features, 1.3, null).probability);
    const val = new StatisticalValidator();
    const metrics = val.evaluate(scores, ds, 1.3);
    expect(metrics.sampleSize).toBe(ds.rows.length);
    expect(metrics.brierScore).toBeDefined();
    expect(metrics.brierScore!).toBeGreaterThanOrEqual(0);
    expect(metrics.expectedCalibrationError).toBeDefined();

    // Known case: perfect predictions → Brier 0
    const cal = val.computeCalibration([1, 0, 1, 0], [1, 0, 1, 0]);
    expect(cal.brierScore).toBe(0);
    expect(cal.meanAbsoluteError).toBe(0);

    // Known case: all 0.5 on alternating → Brier 0.25
    const cal2 = val.computeCalibration([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0]);
    expect(cal2.brierScore).toBeCloseTo(0.25, 5);
  });

  it('uses equity-based drawdown in backtest', () => {
    const bt = new BacktestEngine();
    const result = bt.run(rounds, {
      from: rounds[0].createdAt,
      to: rounds[rounds.length - 1].createdAt,
      target: 1.3,
      entryProbabilityThreshold: 0.2,
      minConfidence: 0.1,
      cashoutTarget: 1.3,
      stake: 700,
      maxDailyEntries: 100,
      maxDrawdownPct: 50,
      modelName: 'baseline-statistical',
      modelVersion: '1.0.0',
    }, 10_000);
    expect(result.metrics.signalsGenerated).toBeGreaterThan(0);
    // drawdown on decisions should be >= 0
    for (const d of result.decisions) {
      expect(d.drawdown).toBeGreaterThanOrEqual(0);
    }
  });

  it('EntryDecisionService wires prediction into RiskEngine', async () => {
    const roundRepo = new InMemoryRoundRepository();
    // Seed history
    for (const r of rounds) {
      await roundRepo.create({
        externalRoundId: r.externalRoundId,
        sessionId: r.sessionId ?? 's1',
        startedAt: r.startedAt,
        crashedAt: r.crashedAt,
        observedCrashPoint: r.crashPoint,
        finalConfirmedCrashPoint: r.crashPoint,
        observationSource: 'websocket',
        dataQuality: 'high',
      });
    }
    const hist = new HistoricalDataService(roundRepo as any);
    const predRepo = new InMemoryPredictionRepository();
    const svc = new EntryDecisionService({
      historicalData: hist,
      predictionRepo: predRepo,
      riskEngine: new RiskEngine(),
    });

    const result = await svc.evaluateEntry({
      roundId: 'r-live-next',
      externalRoundId: 'ext-live-next',
      sessionId: 's1',
      decisionTimestamp: new Date().toISOString(),
      riskInput: baseRiskInput(),
      target: 1.3,
      historyLimit: 80,
      minHistory: 20,
    });

    expect(result.riskResult).toBeDefined();
    expect(typeof result.riskResult.approved).toBe('boolean');
    // With minPredictionProbability 0, signal optional — should still evaluate
    expect(result.riskResult.conditions.predictionAcceptable).toBe(true);
  });

  it('baseline model remains train-free but accepts fit()', () => {
    const model = new BaselineStatisticalModel();
    const builder = new DatasetBuilder();
    const ds = builder.build(rounds, { minHistory: 20 });
    expect(() => model.fit!(ds)).not.toThrow();
    const out = model.predict(
      { roundId: 'x', timestamp: new Date().toISOString(), featureVersion: 'fv-1.0.0', values: { sample_size: 50, quality_score: 1, hit_1_30_50: 0.4, hit_1_30_100: 0.4, since_1_30: 2 }, meta: { sampleSize: 50, dataQualityScore: 1, missingFeatureCount: 0 } },
      1.3,
      null
    );
    expect(out.probability).toBeGreaterThanOrEqual(0);
    expect(out.probability).toBeLessThanOrEqual(1);
    expect(out.reasoning.some((r) => r.includes('not ML') || r.includes('Baseline'))).toBe(true);
  });


  it('rolling buffer serves prediction without per-entry DB', async () => {
    const buf = new RollingHistoryBuffer(50);
    buf.warm(rounds.slice(0, 50));
    expect(buf.isWarmed()).toBe(true);
    expect(buf.size()).toBe(50);
    buf.append(rounds[50] ?? {
      id: 'r-new',
      externalRoundId: 'ext-new',
      sessionId: 's1',
      startedAt: new Date().toISOString(),
      crashedAt: new Date().toISOString(),
      crashPoint: 1.4,
      observationSource: 'websocket',
      dataQuality: 'high',
      createdAt: new Date().toISOString(),
    });
    const prior = buf.getPrior(100, 'live-id');
    expect(prior.every((r) => r.id !== 'live-id')).toBe(true);

    const roundRepo = new InMemoryRoundRepository();
    for (const r of rounds.slice(0, 40)) {
      await roundRepo.create({
        externalRoundId: r.externalRoundId,
        sessionId: 's1',
        startedAt: r.startedAt,
        crashedAt: r.crashedAt,
        observedCrashPoint: r.crashPoint,
        finalConfirmedCrashPoint: r.crashPoint,
        observationSource: 'websocket',
        dataQuality: 'high',
      });
    }
    const hist = new HistoricalDataService(roundRepo as any, 100);
    await hist.ensureWarmed(40);
    const sync = hist.getRecentRoundsSync(30);
    expect(sync.length).toBeGreaterThan(0);
    // append without DB
    hist.onRoundCompleted({
      id: 'extra',
      externalRoundId: 'extra',
      sessionId: 's1',
      startedAt: new Date().toISOString(),
      crashedAt: new Date().toISOString(),
      crashPoint: 3.0,
      observationSource: 'websocket',
      dataQuality: 'high',
      createdAt: new Date().toISOString(),
    });
    expect(hist.getBuffer().size()).toBeGreaterThanOrEqual(sync.length);
  });

});
