import {
  ACIEEngine,
  ACIE_TARGET,
  StrategyLayer,
  DEFAULT_STRATEGY_POLICY,
  SequentialOutcomeLearner,
  TemporalPatternLearner,
  SelfAdaptiveForecastingEngine,
  EvidenceEngine,
} from '../../../../src/prediction/acie/index';

function syntheticRounds(n: number, hitRate = 0.65): Array<{ roundId: string; crashPoint: number }> {
  const out = [];
  for (let i = 0; i < n; i++) {
    const hit = Math.random() < hitRate;
    out.push({
      roundId: `r-${i}`,
      crashPoint: hit ? 1.3 + Math.random() * 2 : 1 + Math.random() * 0.29,
    });
  }
  return out;
}

describe('ACIE v3', () => {
  describe('TPL sequence state', () => {
    it('computes streaks and hit rates', () => {
      const tpl = new TemporalPatternLearner();
      const cps = [1.1, 1.05, 1.2, 1.4, 1.5, 1.1, 1.0, 1.05];
      const s = tpl.computeSequenceState(cps);
      expect(s.currentStreakBelow130).toBe(3);
      expect(s.last10Reached130).toBe(2);
      expect(s.rolling100HitRate).toBeCloseTo(2 / 8, 5);
    });
  });

  describe('SOL residuals', () => {
    it('stores probabilityResidual, squaredError, logLoss', () => {
      const sol = new SequentialOutcomeLearner();
      const tpl = new TemporalPatternLearner();
      const state = tpl.computeSequenceState([1.1, 1.4]);
      const rec = sol.record(
        { roundId: 'r1', crashPoint: 1.5 },
        {
          history: [{ crashPoint: 1.1 }, { crashPoint: 1.4 }],
          sequenceState: state,
          regime: 'normal',
          regimeDuration: 1,
          psiProbability: 0.7,
          psiConfidence: 0.5,
          prediction: true,
        }
      );
      expect(rec.reached130).toBe(true);
      expect(rec.probabilityResidual).toBeCloseTo(0.7 - 1, 5);
      expect(rec.squaredError).toBeCloseTo((0.7 - 1) ** 2, 5);
      expect(rec.logLoss).toBeGreaterThan(0);
      expect(rec.actualResult).toBe(true);
    });
  });

  describe('SAFE calibration bins', () => {
    it('evaluates all 10% bins not only 65-70', () => {
      const sol = new SequentialOutcomeLearner();
      const tpl = new TemporalPatternLearner();
      const state = tpl.computeSequenceState([1.2]);
      for (let i = 0; i < 200; i++) {
        const p = (i % 10) / 10 + 0.05;
        const actual = Math.random() < p;
        sol.record(
          { roundId: `r${i}`, crashPoint: actual ? 1.5 : 1.1 },
          {
            history: [],
            sequenceState: state,
            regime: 'normal',
            regimeDuration: 1,
            psiProbability: p,
            psiConfidence: 0.5,
            prediction: p > 0.6,
          }
        );
      }
      const safe = new SelfAdaptiveForecastingEngine();
      const report = safe.generateCalibrationReport([...sol.getRecords()]);
      expect(report.bins.length).toBeGreaterThan(3);
      expect(report.overallBrierScore).toBeGreaterThanOrEqual(0);
      expect(report.illustrativeBinCalibration).toBeDefined();
    });
  });

  describe('Strategy policy modes', () => {
    const baseCtx = {
      target: ACIE_TARGET,
      probability: 0.68,
      confidenceInterval: [0.6, 0.75] as [number, number],
      calibrationError: 0.04,
      evidence: 'INSUFFICIENT' as const,
      regime: 'normal' as const,
      regimeStability: 5,
      uncertainty: { model: 0.05, data: 0.05, total: 0.07 },
      riskState: {
        currentExposure: 0,
        consecutiveLosses: 0,
        dailyEntriesUsed: 10,
        dailyEntriesLimit: 100,
        balance: 5000,
      },
      baselineProbability: 0.64,
    };

    it('strict mode skips on INSUFFICIENT', () => {
      const s = new StrategyLayer({ ...DEFAULT_STRATEGY_POLICY, mode: 'strict' });
      const d = s.evaluate(baseCtx);
      expect(d.action).toBe('SKIP');
      expect(d.isOpportunity).toBe(false);
    });

    it('frequency_fallback can still produce opportunity from baseline', () => {
      const s = new StrategyLayer({
        ...DEFAULT_STRATEGY_POLICY,
        mode: 'frequency_fallback',
        fallbackThreshold: 0.6,
      });
      const d = s.evaluate(baseCtx);
      expect(d.isOpportunity).toBe(true);
      expect(['ENTRY', 'REDUCED_ENTRY']).toContain(d.action);
    });

    it('adaptive does not hard-block product on weak evidence when P is high enough', () => {
      const s = new StrategyLayer({ ...DEFAULT_STRATEGY_POLICY, mode: 'adaptive' });
      const d = s.evaluate({ ...baseCtx, probability: 0.78, evidence: 'WEAK' });
      // elevated threshold ~0.70; 0.78 should pass
      expect(d.isOpportunity).toBe(true);
    });
  });

  describe('ACIEEngine end-to-end', () => {
    it('evaluates and observes rounds producing signals under frequency_fallback', () => {
      const engine = new ACIEEngine({
        strategyPolicy: { mode: 'frequency_fallback', fallbackThreshold: 0.5, defaultStake: 700 },
      });
      const rounds = syntheticRounds(300, 0.66);
      engine.seedHistory(rounds);

      let opportunities = 0;
      for (let i = 0; i < 50; i++) {
        const { delivered } = engine.produceSignal(
          { dailyEntriesUsed: opportunities, dailyEntriesLimit: 100, balance: 5000 },
          {
            userId: 'u1',
            planName: 'Pro',
            dailyEntriesUsed: opportunities,
            dailyEntriesLimit: 100,
          }
        );
        if (delivered) opportunities++;
        const next = syntheticRounds(1, 0.66)[0];
        next.roundId = `live-${i}`;
        engine.observeRound(next);
      }
      expect(engine.historySize()).toBeGreaterThan(300);
      // With fallback threshold 0.5 and ~66% baseline, expect some opportunities
      expect(opportunities).toBeGreaterThan(0);
    });

    it('entitlement blocks when daily limit reached', () => {
      const engine = new ACIEEngine({
        strategyPolicy: { mode: 'frequency_fallback', fallbackThreshold: 0.5 },
      });
      engine.seedHistory(syntheticRounds(100, 0.7));
      const ev = engine.evaluateNext({ dailyEntriesUsed: 100, dailyEntriesLimit: 100 });
      // Force opportunity path: even if strategy skips, entitlement check is independent
      const ent = engine.checkEntitlement({
        userId: 'u1',
        planName: 'Normal',
        dailyEntriesUsed: 100,
        dailyEntriesLimit: 100,
      });
      expect(ent.allowed).toBe(false);
      expect(ent.reason).toMatch(/Daily entry limit/);
      void ev;
    });

    it('evidence status is one of the four v3 labels', () => {
      const engine = new ACIEEngine();
      engine.seedHistory(syntheticRounds(80, 0.6));
      const snap = engine.getEvidenceSnapshot();
      expect(['SUPPORTED', 'WEAK', 'INSUFFICIENT', 'DEGRADED']).toContain(snap.status);
    });
  });

  describe('Evidence engine degraded language', () => {
    it('never returns CONTRADICTED', () => {
      const eng = new EvidenceEngine();
      const sol = new SequentialOutcomeLearner();
      // PSI always wrong: high prob but losses
      const tpl = new TemporalPatternLearner();
      const state = tpl.computeSequenceState([1.1]);
      for (let i = 0; i < 600; i++) {
        sol.record(
          { roundId: `x${i}`, crashPoint: 1.05 },
          {
            history: [],
            sequenceState: state,
            regime: 'normal',
            regimeDuration: 1,
            psiProbability: 0.8,
            psiConfidence: 0.9,
            prediction: true,
          }
        );
      }
      const report = eng.evaluate([...sol.getRecords()]);
      expect(report.status).toBe('DEGRADED');
      expect((report as { status: string }).status).not.toBe('CONTRADICTED');
    });
  });
});
