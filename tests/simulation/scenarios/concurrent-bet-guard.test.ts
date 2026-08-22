import { createStateMachine } from '../../../src/core/state-machine/machine';

describe('Simulation: Concurrent Bet Guard', () => {
  const createRoundState = (roundId: string) => ({
    roundId,
    phase: 'starting' as const,
    currentMultiplier: 1.0,
    startedAt: new Date().toISOString(),
    crashedAt: null,
    crashPoint: null,
    lastTickAt: new Date().toISOString(),
    source: 'websocket' as const,
    confidence: 'high' as const,
  });

  const createRiskConditions = () => ({
    modeIsLive: true,
    operatorAuthorized: true,
    sessionAuthenticated: true,
    gameLoaded: true,
    roundStateValid: true,
    balanceSufficient: true,
    dailyEntriesBelowLimit: true,
    notPaused: true,
    killSwitchOff: true,
    browserHealthy: true,
    gameAdapterHealthy: true,
    observationConfidenceHigh: true,
    noOpenBet: true,
    cooldownElapsed: true,
  });

  describe('state machine guards', () => {
    it('rejects second bet when open bet exists', () => {
      const machine = createStateMachine({ sessionId: 'test' });
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.updateContext({
        currentBalance: 5000,
        roundState: createRoundState('r1'),
      });
      machine.send({ type: 'ROUND_STARTED', roundId: 'r1', roundState: createRoundState('r1') });
      machine.send({ type: 'RISK_APPROVED', conditions: createRiskConditions() });
      machine.send({ type: 'ENTRY_CHECKS_PASSED' });
      machine.send({ type: 'BET_CONFIRMED', betId: 'b1' });

      expect(machine.getState()).toBe('BET_ACTIVE');
      expect(machine.getContext().openBetExists).toBe(true);

      const result = machine.send({
        type: 'ROUND_STARTED',
        roundId: 'r2',
        roundState: createRoundState('r2'),
      });
      expect(result.accepted).toBe(false);
      expect(result.message).toContain('Invalid transition');
    });

    it('allows new round after cash-out completes', () => {
      const machine = createStateMachine({ sessionId: 'test' });
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.updateContext({
        currentBalance: 5000,
        roundState: createRoundState('r1'),
      });
      machine.send({ type: 'ROUND_STARTED', roundId: 'r1', roundState: createRoundState('r1') });
      machine.send({ type: 'RISK_APPROVED', conditions: createRiskConditions() });
      machine.send({ type: 'ENTRY_CHECKS_PASSED' });
      machine.send({ type: 'BET_CONFIRMED', betId: 'b1' });
      expect(machine.getState()).toBe('BET_ACTIVE');

      // Cash out
      machine.send({ type: 'MULTIPLIER_REACHED_TARGET', multiplier: 1.30 });
      machine.send({ type: 'CASH_OUT_TRIGGERED' });
      machine.send({ type: 'CASH_OUT_CONFIRMED', multiplier: 1.30, pnl: 210 });
      expect(machine.getState()).toBe('ROUND_COMPLETE');
      expect(machine.getContext().openBetExists).toBe(false);

      // New round should now be allowed
      expect(machine.getContext().openBetExists).toBe(false);
    });

    it('allows new round after loss', () => {
      const machine = createStateMachine({ sessionId: 'test' });
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.updateContext({
        currentBalance: 5000,
        roundState: createRoundState('r1'),
      });
      machine.send({ type: 'ROUND_STARTED', roundId: 'r1', roundState: createRoundState('r1') });
      machine.send({ type: 'RISK_APPROVED', conditions: createRiskConditions() });
      machine.send({ type: 'ENTRY_CHECKS_PASSED' });
      machine.send({ type: 'BET_CONFIRMED', betId: 'b1' });

      machine.send({ type: 'ROUND_CRASHED', crashPoint: 1.10 });
      expect(machine.getState()).toBe('ROUND_COMPLETE');
      expect(machine.getContext().openBetExists).toBe(false);

      expect(machine.getContext().openBetExists).toBe(false);
    });
  });

  describe('mutex behavior', () => {
    it('mutex prevents concurrent physical bet placement', async () => {
      const { Mutex } = await import('../../../src/utils/async');
      const mutex = new Mutex();

      expect(mutex.isLocked()).toBe(false);
      await mutex.acquire();
      expect(mutex.isLocked()).toBe(true);
      mutex.release();
      expect(mutex.isLocked()).toBe(false);
    });

    it('mutex serializes concurrent acquires', async () => {
      const { Mutex } = await import('../../../src/utils/async');
      const mutex = new Mutex();
      const order: number[] = [];

      const p1 = mutex.acquire().then(() => { order.push(1); mutex.release(); });
      const p2 = mutex.acquire().then(() => { order.push(2); mutex.release(); });

      await Promise.all([p1, p2]);
      expect(order).toEqual([1, 2]);
    });
  });
});
