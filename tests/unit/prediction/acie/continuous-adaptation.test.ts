import { ACIEEngine, applyOnlineUpdate, createInitialOnlineState } from '../../../../src/prediction/acie/index';
import type { SequenceState } from '../../../../src/prediction/acie/index';

const baseState: SequenceState = {
  last10Reached130: 5,
  last10AvgCrash: 1.5,
  currentStreakBelow130: 0,
  currentStreakAbove130: 1,
  lowClusterActive: false,
  lowClusterLength: 0,
  lowClusterSeverity: 0,
  rolling100HitRate: 0.65,
  rolling500HitRate: 0.65,
  rolling1000HitRate: 0.65,
  recentVolatility: 0.3,
  volatilityTrend: 'stable',
};

describe('ACIE continuous adaptation', () => {
  it('updates online state on every observation without waiting for 500', () => {
    let state = createInitialOnlineState();
    for (let i = 0; i < 30; i++) {
      const cp = i % 3 === 0 ? 1.1 : 1.4;
      state = applyOnlineUpdate(state, {
        crashPoint: cp,
        psiProbability: 0.65,
        modelProbabilities: {
          FrequencyModel: 0.65,
          ConditionalFrequencyModel: 0.66,
          RegimeAdjustedModel: 0.64,
          StreakAwareModel: 0.65,
        },
        sequenceState: baseState,
        regime: 'normal',
        alpha: 0.1,
      });
    }
    expect(state.observationCount).toBe(30);
    expect(state.ewmaHitRate).toBeGreaterThan(0.4);
    expect(state.ewmaHitRate).toBeLessThan(0.95);
    const wSum = Object.values(state.ensembleWeights).reduce((a, b) => a + b, 0);
    expect(wSum).toBeCloseTo(1, 5);
  });

  it('onCrash learns and returns next evaluation every round', () => {
    const engine = new ACIEEngine({
      strategyPolicy: { mode: 'frequency_fallback', fallbackThreshold: 0.5 },
      heavyValidationEvery: 25,
    });

    let heavyRuns = 0;
    for (let i = 0; i < 40; i++) {
      const result = engine.onCrash(
        {
          roundId: `c-${i}`,
          crashPoint: Math.random() < 0.65 ? 1.35 + Math.random() : 1.05 + Math.random() * 0.2,
        },
        { dailyEntriesUsed: 0, dailyEntriesLimit: 100, balance: 5000 }
      );
      expect(result.recordedRoundId).toBe(`c-${i}`);
      expect(result.evaluation.psi.estimatedProbability).toBeGreaterThan(0);
      expect(result.online.observationCount).toBe(i + 1);
      if (result.heavyValidationRan) heavyRuns++;
    }
    // Heavy validation should have fired at least once (every 25)
    expect(heavyRuns).toBeGreaterThanOrEqual(1);
    expect(engine.historySize()).toBe(40);
  });

  it('does not require 500 rounds before producing decisions', () => {
    const engine = new ACIEEngine({
      strategyPolicy: { mode: 'frequency_fallback', fallbackThreshold: 0.4, defaultStake: 700 },
    });
    // Only 20 rounds
    for (let i = 0; i < 20; i++) {
      engine.onCrash({
        roundId: `early-${i}`,
        crashPoint: Math.random() < 0.7 ? 1.5 : 1.1,
      });
    }
    const { evaluation } = engine.produceSignal({
      dailyEntriesUsed: 0,
      dailyEntriesLimit: 100,
      balance: 5000,
    });
    // Engine is allowed to decide (ENTRY/SKIP/REDUCED) — not blocked on sample size alone
    expect(['ENTRY', 'SKIP', 'REDUCED_ENTRY']).toContain(evaluation.strategy.action);
    expect(evaluation.psi.target).toBe(1.3);
  });

  it('ensemble weights shift after systematic model errors', () => {
    let state = createInitialOnlineState();
    for (let i = 0; i < 80; i++) {
      // Frequency always wrong high; Conditional closer to actual 0
      state = applyOnlineUpdate(state, {
        crashPoint: 1.05, // always miss
        psiProbability: 0.8,
        modelProbabilities: {
          FrequencyModel: 0.9,
          ConditionalFrequencyModel: 0.2,
          RegimeAdjustedModel: 0.85,
          StreakAwareModel: 0.8,
        },
        sequenceState: baseState,
        regime: 'low-cluster',
        alpha: 0.08,
      });
    }
    expect(state.ensembleWeights.ConditionalFrequencyModel).toBeGreaterThan(
      state.ensembleWeights.FrequencyModel
    );
  });
});
