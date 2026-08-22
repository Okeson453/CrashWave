/**
 * Simulation: Live Loss Scenario
 *
 * Simulates a complete round where a bet is placed, but the multiplier
 * crashes at 1.15× before reaching the 1.30× target.
 *
 * Expected outcome:
 *   - Bet state: PENDING → RESERVED → PLACED → ACTIVE → LOST
 *   - PnL: −700 units (full stake lost)
 *   - Cash-out is never triggered
 *   - No UNKNOWN states
 */

import { LiveBetExecutor } from '../../../src/betting/live-executor';
import { LiveCashOutExecutor } from '../../../src/betting/live-cashout';
import { ConfirmationObserver } from '../../../src/betting/confirmation';
import { ExecutionSafeguards } from '../../../src/betting/execution-safeguards';
import { BalanceTracker } from '../../../src/ledger/balance-tracker';
import { DailyEntryCounter } from '../../../src/ledger/daily-entries';
import { PlaceBetRequest } from '../../../src/betting/types';

const mockPage = {
  locator: () => ({
    first: () => ({
      waitFor: jest.fn().mockResolvedValue(undefined),
      fill: jest.fn().mockResolvedValue(undefined),
      isDisabled: jest.fn().mockResolvedValue(false),
      click: jest.fn().mockResolvedValue(undefined),
      isVisible: jest.fn().mockResolvedValue(true),
      textContent: jest.fn().mockResolvedValue(''),
    }),
  }),
  evaluate: jest.fn().mockResolvedValue([]),
  evaluateOnNewDocument: jest.fn().mockResolvedValue(undefined),
} as any;

const createMockRepo = () => ({
  create: jest.fn().mockImplementation((input: any) => Promise.resolve({
    id: input.id ?? 'bet-1',
    sessionId: input.sessionId ?? null,
    roundId: input.roundId ?? null,
    dailyKey: input.dailyKey,
    stake: input.stake,
    cashOutTarget: input.cashOutTarget,
    state: input.state ?? 'PENDING',
    balanceBefore: input.balanceBefore ?? null,
    balanceAfter: null,
    pnl: null,
    requestedAt: null,
    placedAt: null,
    confirmedAt: null,
    cashOutRequestedAt: null,
    cashOutConfirmedAt: null,
    observedCashOutMultiplier: null,
    confirmedCashOutMultiplier: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  update: jest.fn().mockImplementation((id: string, input: any) => Promise.resolve({
    id,
    sessionId: 'session-1',
    roundId: 'round-1',
    dailyKey: '2024-01-01',
    stake: 700,
    cashOutTarget: 1.30,
    state: input.state ?? 'PENDING',
    balanceBefore: 5000,
    balanceAfter: null,
    pnl: input.pnl ?? null,
    requestedAt: input.requestedAt ?? null,
    placedAt: input.placedAt ?? null,
    confirmedAt: input.confirmedAt ?? null,
    cashOutRequestedAt: input.cashOutRequestedAt ?? null,
    cashOutConfirmedAt: input.cashOutConfirmedAt ?? null,
    observedCashOutMultiplier: input.observedCashOutMultiplier ?? null,
    confirmedCashOutMultiplier: input.confirmedCashOutMultiplier ?? null,
    failureReason: input.failureReason ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  updateState: jest.fn().mockImplementation((id: string, state: string) => Promise.resolve({
    id,
    sessionId: 'session-1',
    roundId: 'round-1',
    dailyKey: '2024-01-01',
    stake: 700,
    cashOutTarget: 1.30,
    state,
    balanceBefore: 5000,
    balanceAfter: null,
    pnl: null,
    requestedAt: null,
    placedAt: null,
    confirmedAt: null,
    cashOutRequestedAt: null,
    cashOutConfirmedAt: null,
    observedCashOutMultiplier: null,
    confirmedCashOutMultiplier: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  findById: jest.fn().mockImplementation((id: string) => Promise.resolve({
    id,
    sessionId: 'session-1',
    roundId: 'round-loss-1',
    dailyKey: '2024-01-01',
    stake: 700,
    cashOutTarget: 1.30,
    state: 'ACTIVE',
    balanceBefore: 5000,
    balanceAfter: null,
    pnl: null,
    requestedAt: null,
    placedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    cashOutRequestedAt: null,
    cashOutConfirmedAt: null,
    observedCashOutMultiplier: null,
    confirmedCashOutMultiplier: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  findByIdOrThrow: jest.fn().mockImplementation((id: string) => Promise.resolve({
    id,
    sessionId: 'session-1',
    roundId: 'round-loss-1',
    dailyKey: '2024-01-01',
    stake: 700,
    cashOutTarget: 1.30,
    state: 'ACTIVE',
    balanceBefore: 5000,
    balanceAfter: null,
    pnl: null,
    requestedAt: null,
    placedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    cashOutRequestedAt: null,
    cashOutConfirmedAt: null,
    observedCashOutMultiplier: null,
    confirmedCashOutMultiplier: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
});

const createMockBus = () => ({
  emitTyped: jest.fn().mockResolvedValue(undefined),
  emit: jest.fn().mockResolvedValue(undefined),
  on: jest.fn().mockReturnValue(() => {}),
  once: jest.fn().mockReturnValue(undefined),
  listenerCount: jest.fn().mockReturnValue(0),
  removeAllListeners: jest.fn().mockReturnValue(undefined),
  getEventNames: jest.fn().mockReturnValue([]),
});

describe('Simulation: Live Loss', () => {
  it('completes a losing round from placement to crash', async () => {
    const repo = createMockRepo() as any;
    const bus = createMockBus() as any;

    const tracker = new BalanceTracker({ reconciliationTolerance: 0.01 });
    tracker.record({ timestamp: new Date().toISOString(), balance: 5000, currencyOrUnit: 'USD', source: 'api' });

    const counter = new DailyEntryCounter();

    const appConfig = {
      system: { mode: 'live', logLevel: 'info', serviceName: 'test' },
      betting: { stakePerEntry: 700, cashOutTarget: 1.30, maxDailyEntries: 100, currencyUnit: 'USD', dayBoundaryTimezone: 'UTC' },
      risk: { minBalanceForEntry: 700, balanceBuffer: 700, maxConsecutiveErrorsBeforeStop: 3, maxCashOutFailuresBeforeStop: 2, cooldownMs: 5000 , minPredictionProbability: 0, minPredictionConfidence: 0, requirePredictionForLive: false },
      observation: { maxTickLatencyMs: 1000, minConfidenceForEntry: 'high', requireRoundId: true, latencyThresholdHealthyMs: 500, latencyThresholdDegradedMs: 1000 },
      telegram: { allowedUserIds: [], verbosity: 'normal', sendRoundStart: false, sendRoundResult: true, sendHealthWarnings: true, rateLimitMessagesPerMinute: 30 },
      browser: { headless: true, viewportWidth: 1366, viewportHeight: 900, profileDirectory: './test-profile', timeoutMs: 30000 },
      persistence: { databasePoolSize: 10, redisCommandTimeoutMs: 5000, redisReconnectIntervalMs: 3000 },
      health: { checkIntervalMs: 30000, degradationThreshold: 2, failureThreshold: 3 },
    };

    const safeguards = new ExecutionSafeguards(tracker, counter, appConfig as any);
    const observer = new ConfirmationObserver(mockPage);
    jest.spyOn(observer, 'waitForBetPlaced').mockResolvedValue(true);

    const executor = new LiveBetExecutor(mockPage, repo, observer, safeguards, bus, {
      placementTimeoutMs: 5000,
      maxPlacementRetries: 1,
      placementRetryDelayMs: 100,
      postClickObservationDelayMs: 50,
    });

    const cashOutExecutor = new LiveCashOutExecutor(mockPage, repo, observer, bus, {
      cashOutTimeoutMs: 5000,
      postClickObservationDelayMs: 50,
      cashOutGraceMultiplier: 0.02,
    });

    const request: PlaceBetRequest = {
      betId: 'bet-loss-1',
      roundId: 'round-loss-1',
      sessionId: 'session-1',
      stake: 700,
      target: 1.30,
      idempotencyKey: 'idem-loss-1',
      dryRun: false,
    };

    // Step 1: Place the bet
    const placeResult = await executor.placeLiveBet(request);
    expect(placeResult.placed).toBe(true);
    expect(placeResult.state).toBe('PLACED');

    // Step 2: Arm cash-out
    cashOutExecutor.arm(request.betId, request.roundId, request.target);

    // Step 3: Simulate multiplier updates (never reaches target)
    await cashOutExecutor.onMultiplierUpdate(1.05);
    await cashOutExecutor.onMultiplierUpdate(1.10);
    await cashOutExecutor.onMultiplierUpdate(1.15);

    // Step 4: Round crashes at 1.15x
    await cashOutExecutor.onRoundCrash(request.roundId, 1.15);

    // Step 5: Verify bet is LOST
    const updates = repo.update.mock.calls;
    const lostUpdate = updates.find((call: any[]) => call[1].state === 'LOST');
    expect(lostUpdate).toBeDefined();
    expect(lostUpdate[1].pnl).toBe(-700);

    // Step 6: Verify no UNKNOWN states
    const unknownUpdates = updates.filter((call: any[]) => call[1].state === 'UNKNOWN');
    expect(unknownUpdates).toHaveLength(0);
  });
});
