import { RiskEngine } from '@/betting/risk-engine';
import type { RiskEvaluationInput } from '@/betting/types';
import { globalFinancialCircuitBreaker } from '@/core/circuit-breaker/financial-circuit-breaker';

function base(partial: Partial<RiskEvaluationInput> = {}): RiskEvaluationInput {
  return {
    mode: 'live',
    operatorAuthorized: true,
    sessionAuthenticated: true,
    gameLoaded: true,
    roundState: {
      phase: 'starting',
      roundId: 'r1',
      multiplier: 1,
      startedAt: new Date().toISOString(),
      crashedAt: null,
      crashPoint: null,
      confidence: 'high',
    } as never,
    currentBalance: 100_000,
    dailyEntriesConfirmed: 0,
    paused: false,
    killSwitch: false,
    browserHealthy: true,
    gameAdapterHealthy: true,
    openBetExists: false,
    cooldownElapsed: true,
    requiredStake: 700,
    balanceBuffer: 700,
    maxDailyEntries: 500,
    minConfidenceForEntry: 'medium',
    consecutiveErrors: 0,
    maxConsecutiveErrors: 5,
    cashOutFailures: 0,
    maxCashOutFailures: 3,
    ...partial,
  };
}

describe('RiskEngine matrix', () => {
  afterEach(() => {
    void globalFinancialCircuitBreaker.recordSuccess();
  });

  it('approves all-green live', () => {
    const eng = new RiskEngine();
    expect(eng.evaluate(base()).approved).toBe(true);
  });

  it('approves dry-run without auth', () => {
    const eng = new RiskEngine();
    const r = eng.evaluate(
      base({ mode: 'dry-run', sessionAuthenticated: false })
    );
    expect(r.approved).toBe(true);
  });

  it('rejects killSwitch', () => {
    const eng = new RiskEngine();
    expect(eng.evaluate(base({ killSwitch: true })).approved).toBe(false);
  });

  it('rejects openBetExists', () => {
    const eng = new RiskEngine();
    expect(eng.evaluate(base({ openBetExists: true })).approved).toBe(false);
  });

  it('rejects consecutiveErrors at max', () => {
    const eng = new RiskEngine();
    expect(
      eng.evaluate(base({ consecutiveErrors: 5, maxConsecutiveErrors: 5 })).approved
    ).toBe(false);
  });
});
