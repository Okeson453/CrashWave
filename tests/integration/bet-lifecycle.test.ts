import { createStateMachine } from '../../src/core/state-machine/machine';
import { BetExecutor, MockBetPlacementAdapter } from '../../src/betting/executor';
import { InMemoryIdempotencyStore } from '../../src/betting/idempotency';
import { CashOutController, createTestMultiplierStream } from '../../src/betting/cashout';
import { InMemoryDailyEntryLedger } from '../../src/ledger/daily-entries';
import { PnlCalculator } from '../../src/ledger/pnl-calculator';
import { PlaceBetRequest } from '../../src/betting/types';

describe('Integration: Bet Lifecycle', () => {
  it('completes full win lifecycle: observe → evaluate → place → cash-out → record', async () => {
    const machine = createStateMachine({ sessionId: 'test-session' });
    const adapter = new MockBetPlacementAdapter();
    const idempotency = new InMemoryIdempotencyStore();
    const ledger = new InMemoryDailyEntryLedger(100);
    const calc = new PnlCalculator(700, 1.30);

    // 1. System initializes
    machine.send({ type: 'BROWSER_READY' });
    machine.send({ type: 'GAME_LOADED' });
    expect(machine.getState()).toBe('OBSERVING');

    // 2. Round starts
    const roundState = {
      roundId: 'r1', phase: 'starting' as const, currentMultiplier: 1.0,
      startedAt: new Date().toISOString(), crashedAt: null, crashPoint: null,
      lastTickAt: new Date().toISOString(), source: 'websocket' as const, confidence: 'high' as const,
    };
    machine.updateContext({ currentBalance: 5000 });
    machine.send({ type: 'ROUND_STARTED', roundId: 'r1', roundState });
    expect(machine.getState()).toBe('ENTRY_EVALUATING');

    // 3. Risk approved
    machine.send({
      type: 'RISK_APPROVED',
      conditions: {
        modeIsLive: true, operatorAuthorized: true, sessionAuthenticated: true,
        gameLoaded: true, roundStateValid: true, balanceSufficient: true,
        dailyEntriesBelowLimit: true, notPaused: true, killSwitchOff: true,
        browserHealthy: true, gameAdapterHealthy: true, observationConfidenceHigh: true,
        noOpenBet: true, cooldownElapsed: true,
      },
    });
    expect(machine.getState()).toBe('ENTRY_APPROVED');

    // 4. Reserve daily entry
    const dailyKey = '2026-08-18';
    const reservation = await ledger.reserve(dailyKey, 'bet-1', 'test-session');
    expect(reservation.success).toBe(true);

    // 5. Place bet
    machine.send({ type: 'ENTRY_CHECKS_PASSED' });
    expect(machine.getState()).toBe('BET_PLACING');

    const executor = new BetExecutor(adapter, idempotency, {
      placementTimeoutMs: 5000,
      maxPlacementRetries: 1,
      placementRetryDelayMs: 100,
    });

    const request: PlaceBetRequest = {
      betId: 'bet-1',
      roundId: 'r1',
      sessionId: 'test-session',
      stake: 700,
      target: 1.30,
      idempotencyKey: 'idem-1',
      dryRun: false,
    };

    const placementResult = await executor.placeBet(request);
    expect(placementResult.placed).toBe(true);

    machine.send({ type: 'BET_CONFIRMED', betId: 'bet-1' });
    expect(machine.getState()).toBe('BET_ACTIVE');
    expect(machine.getContext().openBetExists).toBe(true);

    // 6. Monitor and cash out
    const controller = new CashOutController('bet-1', 'r1', adapter, {
      targetMultiplier: 1.30,
      latencyBufferMs: 0,
      confirmationTimeoutMs: 5000,
      preferNativeAutoCashOut: false,
    });

    const stream = createTestMultiplierStream({ crashPoint: 2.0, tickIntervalMs: 10 });
    const monitorPromise = controller.monitor(stream.onTick, stream.onCrash);
    stream.start();

    const cashOutResult = await monitorPromise;
    expect(cashOutResult.success).toBe(true);
    expect(cashOutResult.finalState).toBe('CASHED_OUT');
    expect(cashOutResult.pnl).toBe(210);

    machine.send({ type: 'MULTIPLIER_REACHED_TARGET', multiplier: 1.30 });
    machine.send({ type: 'CASH_OUT_TRIGGERED' });
    machine.send({ type: 'CASH_OUT_CONFIRMED', multiplier: 1.30, pnl: 210 });
    expect(machine.getState()).toBe('ROUND_COMPLETE');
    expect(machine.getContext().openBetExists).toBe(false);

    // 7. Record outcome
    await ledger.confirm(dailyKey, 'bet-1');
    machine.send({ type: 'OUTCOME_RECORDED' });
    expect(machine.getState()).toBe('RESULT_RECORDED');

    // 8. Verify P&L
    const entries = [{ betId: 'bet-1', roundId: 'r1', dailyKey, stake: 700, target: 1.30, outcome: 'win' as const, pnl: 210, cashOutMultiplier: 1.30, timestamp: new Date().toISOString() }];
    const summary = calc.computeSummary(entries);
    expect(summary.wins).toBe(1);
    expect(summary.netPnl).toBe(210);

    // 9. Cooldown
    machine.send({ type: 'COOLDOWN_ELAPSED' });
    expect(machine.getState()).toBe('COOLDOWN');

    machine.send({ type: 'COOLDOWN_ELAPSED' });
    expect(machine.getState()).toBe('OBSERVING');
  });

  it('completes full loss lifecycle: observe → evaluate → place → crash → record', async () => {
    const machine = createStateMachine({ sessionId: 'test-session' });
    const adapter = new MockBetPlacementAdapter();
    adapter.setBehavior({ cashOutSuccess: false });
    const ledger = new InMemoryDailyEntryLedger(100);

    // Setup and place bet
    machine.send({ type: 'BROWSER_READY' });
    machine.send({ type: 'GAME_LOADED' });
    machine.updateContext({ currentBalance: 5000 });
    machine.send({
      type: 'ROUND_STARTED', roundId: 'r1',
      roundState: {
        roundId: 'r1', phase: 'starting', currentMultiplier: 1.0,
        startedAt: new Date().toISOString(), crashedAt: null, crashPoint: null,
        lastTickAt: new Date().toISOString(), source: 'websocket', confidence: 'high'
      },
    });
    machine.send({
      type: 'RISK_APPROVED',
      conditions: {
        modeIsLive: true, operatorAuthorized: true, sessionAuthenticated: true,
        gameLoaded: true, roundStateValid: true, balanceSufficient: true,
        dailyEntriesBelowLimit: true, notPaused: true, killSwitchOff: true,
        browserHealthy: true, gameAdapterHealthy: true, observationConfidenceHigh: true,
        noOpenBet: true, cooldownElapsed: true,
      },
    });

    const dailyKey = '2026-08-18';
    await ledger.reserve(dailyKey, 'bet-loss', 'test-session');

    machine.send({ type: 'ENTRY_CHECKS_PASSED' });
    machine.send({ type: 'BET_CONFIRMED', betId: 'bet-loss' });
    expect(machine.getState()).toBe('BET_ACTIVE');

    // Round crashes before target
    const controller = new CashOutController('bet-loss', 'r1', adapter, {
      targetMultiplier: 1.30,
      latencyBufferMs: 0,
      confirmationTimeoutMs: 5000,
      preferNativeAutoCashOut: false,
    });

    const stream = createTestMultiplierStream({ crashPoint: 1.15, tickIntervalMs: 10 });
    const monitorPromise = controller.monitor(stream.onTick, stream.onCrash);
    stream.start();

    const result = await monitorPromise;
    expect(result.success).toBe(false);
    expect(result.finalState).toBe('LOST');

    machine.send({ type: 'ROUND_CRASHED', crashPoint: 1.15 });
    expect(machine.getState()).toBe('ROUND_COMPLETE');
    expect(machine.getContext().openBetExists).toBe(false);

    await ledger.confirm(dailyKey, 'bet-loss');
    machine.send({ type: 'OUTCOME_RECORDED' });
    expect(machine.getState()).toBe('RESULT_RECORDED');
  });
});
