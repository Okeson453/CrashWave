/**
 * E2E: Live Smoke Test
 *
 * Verifies that the live execution pipeline can be initialized,
 * that all critical components are wired correctly, and that
 * the system refuses to place bets when pre-flight conditions
 * are not met (e.g., insufficient balance, wrong mode).
 *
 * This test does NOT place real bets — it validates the wiring
 * and safeguard logic end-to-end.
 */

import { LiveBetExecutor } from '../../src/betting/live-executor';
import { LiveCashOutExecutor } from '../../src/betting/live-cashout';
import { ConfirmationObserver } from '../../src/betting/confirmation';
import { ExecutionSafeguards } from '../../src/betting/execution-safeguards';
import { BalanceTracker } from '../../src/ledger/balance-tracker';
import { DailyEntryCounter } from '../../src/ledger/daily-entries';
import { BalanceReconciliation } from '../../src/ledger/balance-reconciliation';
import { UnknownStateRecovery } from '../../src/ledger/unknown-state-recovery';
import { RecoveryManager } from '../../src/core/recovery-manager';
import { EmergencyStop } from '../../src/core/emergency-stop';
import { LiveHealthChecks } from '../../src/observability/health/live-checks';
import { LiveAlerts } from '../../src/observability/alerts/live-alerts';
import { PlaceBetRequest } from '../../src/betting/types';
import { AppConfig } from '../../src/config/schema';

describe('E2E: Live Smoke Test', () => {
  const mockPage = {
    locator: () => ({
      first: () => ({
        waitFor: jest.fn().mockResolvedValue(undefined),
        fill: jest.fn().mockResolvedValue(undefined),
        isDisabled: jest.fn().mockResolvedValue(false),
        click: jest.fn().mockResolvedValue(undefined),
        isVisible: jest.fn().mockResolvedValue(true),
        textContent: jest.fn().mockResolvedValue('5000.00'),
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
    updateState: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue(null),
    findByIdOrThrow: jest.fn().mockImplementation((id: string) => Promise.resolve({
      id,
      sessionId: 'session-1',
      roundId: 'round-1',
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
    countByState: jest.fn().mockResolvedValue(0),
    findByState: jest.fn().mockResolvedValue([]),
    findUnknownBets: jest.fn().mockResolvedValue([]),
    findActiveBets: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  });

  const createMockRoundRepo = () => ({
    findById: jest.fn().mockResolvedValue(null),
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

  const createAppConfig = (mode: 'live' | 'dry-run' | 'observe-only'): AppConfig => ({
    system: { mode, logLevel: 'info', serviceName: 'test' },
    betting: { stakePerEntry: 700, cashOutTarget: 1.30, maxDailyEntries: 100, currencyUnit: 'USD', dayBoundaryTimezone: 'UTC' },
    risk: { minBalanceForEntry: 700, balanceBuffer: 700, maxConsecutiveErrorsBeforeStop: 3, maxCashOutFailuresBeforeStop: 2, cooldownMs: 5000 },
    observation: { maxTickLatencyMs: 1000, minConfidenceForEntry: 'high', requireRoundId: true, latencyThresholdHealthyMs: 500, latencyThresholdDegradedMs: 1000 },
    telegram: { allowedUserIds: [], verbosity: 'normal', sendRoundStart: false, sendRoundResult: true, sendHealthWarnings: true, rateLimitMessagesPerMinute: 30 },
    browser: { headless: true, viewportWidth: 1366, viewportHeight: 900, profileDirectory: './test-profile', timeoutMs: 30000 },
    persistence: { databasePoolSize: 10, redisCommandTimeoutMs: 5000, redisReconnectIntervalMs: 3000 },
    health: { checkIntervalMs: 30000, degradationThreshold: 2, failureThreshold: 3 },
  });

  it('wires all live components together without errors', async () => {
    const repo = createMockRepo() as any;
    const roundRepo = createMockRoundRepo() as any;
    const bus = createMockBus() as any;

    const tracker = new BalanceTracker({ reconciliationTolerance: 0.01 });
    tracker.record({ timestamp: new Date().toISOString(), balance: 5000, currencyOrUnit: 'USD', source: 'api' });

    const counter = new DailyEntryCounter();
    const appConfig = createAppConfig('live');

    const safeguards = new ExecutionSafeguards(tracker, counter, appConfig, bus);
    const observer = new ConfirmationObserver(mockPage);
    const executor = new LiveBetExecutor(mockPage, repo, observer, safeguards, bus);
    const cashOutExecutor = new LiveCashOutExecutor(mockPage, repo, observer, bus);
    const reconciliation = new BalanceReconciliation(repo, tracker, bus);
    const unknownRecovery = new UnknownStateRecovery(repo, roundRepo, bus);
    const recoveryManager = new RecoveryManager(unknownRecovery, reconciliation, repo, bus);
    const emergencyStop = new EmergencyStop(repo, bus);
    const healthChecks = new LiveHealthChecks(mockPage, repo, bus);
    const alerts = new LiveAlerts(bus);

    // Verify all components are instantiated
    expect(executor).toBeDefined();
    expect(cashOutExecutor).toBeDefined();
    expect(reconciliation).toBeDefined();
    expect(unknownRecovery).toBeDefined();
    expect(recoveryManager).toBeDefined();
    expect(emergencyStop).toBeDefined();
    expect(healthChecks).toBeDefined();
    expect(alerts).toBeDefined();

    // Verify recovery manager can run
    const recoveryResult = await recoveryManager.runRecovery();
    expect(recoveryResult.canResume).toBe(true);

    // Verify emergency stop can be triggered
    const stopResult = await emergencyStop.trigger('Smoke test trigger');
    expect(stopResult.triggered).toBe(true);

    // Reset for further tests
    await emergencyStop.reset('test-operator');
  });

  it('rejects live bet when system mode is not live', async () => {
    const repo = createMockRepo() as any;
    const bus = createMockBus() as any;

    const tracker = new BalanceTracker({ reconciliationTolerance: 0.01 });
    tracker.record({ timestamp: new Date().toISOString(), balance: 5000, currencyOrUnit: 'USD', source: 'api' });

    const counter = new DailyEntryCounter();
    const appConfig = createAppConfig('dry-run');

    const safeguards = new ExecutionSafeguards(tracker, counter, appConfig, bus);
    const observer = new ConfirmationObserver(mockPage);
    const executor = new LiveBetExecutor(mockPage, repo, observer, safeguards, bus);

    const request: PlaceBetRequest = {
      betId: 'smoke-bet-1',
      roundId: 'smoke-round-1',
      sessionId: 'session-1',
      stake: 700,
      target: 1.30,
      idempotencyKey: 'smoke-idem-1',
      dryRun: false,
    };

    const result = await executor.placeLiveBet(request);
    expect(result.placed).toBe(false);
    expect(result.state).toBe('FAILED');
    expect(result.error).toContain("dry-run");
  });

  it('rejects live bet when balance is insufficient', async () => {
    const repo = createMockRepo() as any;
    const bus = createMockBus() as any;

    const tracker = new BalanceTracker({ reconciliationTolerance: 0.01 });
    tracker.record({ timestamp: new Date().toISOString(), balance: 1000, currencyOrUnit: 'USD', source: 'api' });

    const counter = new DailyEntryCounter();
    const appConfig = createAppConfig('live');

    const safeguards = new ExecutionSafeguards(tracker, counter, appConfig, bus);
    const observer = new ConfirmationObserver(mockPage);
    const executor = new LiveBetExecutor(mockPage, repo, observer, safeguards, bus);

    const request: PlaceBetRequest = {
      betId: 'smoke-bet-2',
      roundId: 'smoke-round-2',
      sessionId: 'session-1',
      stake: 700,
      target: 1.30,
      idempotencyKey: 'smoke-idem-2',
      dryRun: false,
    };

    const result = await executor.placeLiveBet(request);
    expect(result.placed).toBe(false);
    expect(result.state).toBe('FAILED');
    expect(result.error).toContain('Insufficient balance');
  });

  it('health checks produce a valid report', async () => {
    const repo = createMockRepo() as any;
    const bus = createMockBus() as any;

    const healthChecks = new LiveHealthChecks(mockPage, repo, bus, {
      checkIntervalMs: 30000,
      domCheckTimeoutMs: 2000,
    });

    const report = await healthChecks.runCheck();
    expect(report).toBeDefined();
    expect(report.overall).toBeDefined();
    expect(report.components).toBeDefined();
    expect(report.components.length).toBeGreaterThan(0);
    expect(report.timestamp).toBeDefined();
  });
});
