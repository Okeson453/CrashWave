import { PredictiveSequenceIntelligence } from '@/prediction/acie/psi';
import { TemporalPatternLearner } from '@/prediction/acie/tpl';
import type { SOLRecord } from '@/prediction/acie/types';

function makeHistory(n: number): SOLRecord[] {
  const out: SOLRecord[] = [];
  for (let i = 0; i < n; i++) {
    const streak = i % 7;
    const reached = i % 3 !== 0;
    out.push({
      roundId: `r-${i}`,
      timestamp: new Date(Date.now() - (n - i) * 1000).toISOString(),
      crashPoint: reached ? 1.5 : 1.1,
      reached130: reached,
      previousOutcomes: [],
      previousReached130: [],
      sequenceState: {
        last10Reached130: 6,
        last10AvgCrash: 1.4,
        currentStreakBelow130: streak,
        currentStreakAbove130: 0,
        lowClusterActive: streak >= 3,
        lowClusterLength: streak >= 3 ? streak : 0,
        lowClusterSeverity: 1.1,
        rolling100HitRate: 0.65,
        rolling500HitRate: 0.64,
        rolling1000HitRate: 0.63,
        recentVolatility: 0.5,
        volatilityTrend: 'stable',
      },
      regime: 'normal',
      regimeDuration: 5,
      psiProbability: 0.65,
      psiConfidence: 0.5,
      prediction: false,
      actualResult: reached,
      probabilityResidual: 0,
      squaredError: 0,
      logLoss: 0.5,
      binnedProbability: 0.6,
    });
  }
  return out;
}

describe('PSI inference speed', () => {
  it('estimateWithModels stays under budget on large history', () => {
    const tpl = new TemporalPatternLearner();
    const psi = new PredictiveSequenceIntelligence(tpl);
    const crashPoints = Array.from({ length: 2000 }, (_, i) => (i % 5 === 0 ? 1.12 : 1.4));
    const history = makeHistory(3000);
    const sequenceState = tpl.computeSequenceState(crashPoints);
    const regime = tpl.detectRegime(sequenceState);

    // Warm-up
    for (let i = 0; i < 20; i++) {
      psi.estimateWithModels({
        crashPoints,
        sequenceState,
        regime,
        history,
        ewmaHitRate: 0.66,
      });
    }

    const iters = 200;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) {
      psi.estimateWithModels({
        crashPoints,
        sequenceState,
        regime,
        history,
        ewmaHitRate: 0.66,
      });
    }
    const t1 = process.hrtime.bigint();
    const avgUs = Number(t1 - t0) / 1e3 / iters;

    // Hot path should be well under 1ms average even on large buffers
    expect(avgUs).toBeLessThan(1000);
  });

  it('estimate does not double-run vs estimateWithModels probability', () => {
    const tpl = new TemporalPatternLearner();
    const psi = new PredictiveSequenceIntelligence(tpl);
    const crashPoints = Array.from({ length: 100 }, (_, i) => (i % 4 === 0 ? 1.1 : 1.5));
    const history = makeHistory(200);
    const sequenceState = tpl.computeSequenceState(crashPoints);
    const regime = tpl.detectRegime(sequenceState);
    const params = {
      crashPoints,
      sequenceState,
      regime,
      history,
      ewmaHitRate: 0.65,
    };
    const a = psi.estimate(params);
    const b = psi.estimateWithModels(params);
    expect(b.psi.estimatedProbability).toBeCloseTo(a.estimatedProbability, 5);
    expect(b.models).toHaveLength(7);
  });
});
