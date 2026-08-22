import { RiskEngine } from '../../../src/betting/risk-engine';
import { RiskEvaluationInput } from '../../../src/betting/types';

describe('Simulation: Insufficient Balance', () => {
  const baseInput: RiskEvaluationInput = {
    mode: 'live',
    operatorAuthorized: true,
    sessionAuthenticated: true,
    gameLoaded: true,
    roundState: {
      roundId: 'r1',
      phase: 'starting',
      currentMultiplier: 1.0,
      startedAt: new Date().toISOString(),
      crashedAt: null,
      crashPoint: null,
      lastTickAt: new Date().toISOString(),
      source: 'websocket',
      confidence: 'high',
    },
    currentBalance: 5000,
    dailyEntriesConfirmed: 0,
    paused: false,
    killSwitch: false,
    browserHealthy: true,
    gameAdapterHealthy: true,
    openBetExists: false,
    cooldownElapsed: true,
    requiredStake: 700,
    balanceBuffer: 500,
    maxDailyEntries: 100,
    minConfidenceForEntry: 'high',
    consecutiveErrors: 0,
    maxConsecutiveErrors: 3,
    cashOutFailures: 0,
    maxCashOutFailures: 2,
  };

  it('rejects when balance below stake + buffer', () => {
    const engine = new RiskEngine();
    const result = engine.evaluate({
      ...baseInput,
      currentBalance: 1000,
      requiredStake: 700,
      balanceBuffer: 500,
    });
    expect(result.approved).toBe(false);
    expect(result.conditions.balanceSufficient).toBe(false);
  });

  it('rejects when balance is exactly at threshold', () => {
    const engine = new RiskEngine();
    const result = engine.evaluate({
      ...baseInput,
      currentBalance: 1200,
      requiredStake: 700,
      balanceBuffer: 500,
    });
    expect(result.approved).toBe(true);
    expect(result.conditions.balanceSufficient).toBe(true);
  });

  it('rejects when balance is null', () => {
    const engine = new RiskEngine();
    const result = engine.evaluate({
      ...baseInput,
      currentBalance: null,
    });
    expect(result.approved).toBe(false);
    expect(result.conditions.balanceSufficient).toBe(false);
  });

  it('rejects when balance is zero', () => {
    const engine = new RiskEngine();
    const result = engine.evaluate({
      ...baseInput,
      currentBalance: 0,
    });
    expect(result.approved).toBe(false);
  });
});
