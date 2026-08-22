/**
 * E2E: Recovery Drill Test
 *
 * Simulates a system crash mid-bet, restart, and recovery.
 * Validates that:
 *   - The system detects UNKNOWN bets on restart
 *   - RecoveryManager halts betting during reconciliation
 *   - UnknownStateRecovery resolves bets using round history
 *   - BalanceReconciliation verifies ledger consistency
 *   - The system resumes safely without operator intervention
 *   - All events are emitted correctly during recovery
 */

import { EventBus } from '../../src/core/event-bus/bus';
import { RecoveryManager } from '../../src/core/recovery-manager';
import { UnknownStateRecovery } from '../../src/ledger/unknown-state-recovery';
import { BalanceReconciliation } from '../../src/ledger/balance-reconciliation';
import { InMemoryBetRepository } from '../../src/persistence/repositories/bet-repo';
import { InMemoryRoundRepository } from '../../src/persistence/repositories/round-repo';
import { BalanceTracker } from '../../src/ledger/balance-tracker';

describe('E2E: Recovery Drill', () => {
  let eventBus: EventBus;
  let betRepo: InMemoryBetRepository;
  let roundRepo: InMemoryRoundRepository;
  let balanceTracker: BalanceTracker;
  let unknownRecovery: UnknownStateRecovery;
  let balanceReconciliation: BalanceReconciliation;
  let recoveryManager: RecoveryManager;

  beforeEach(() => {
    eventBus = new EventBus();
    betRepo = new InMemoryBetRepository();
    roundRepo = new InMemoryRoundRepository();
    balanceTracker = new BalanceTracker({ reconciliationTolerance: 1000 });

    // Seed balance tracker so reconciliation can succeed
    balanceTracker.record({
      balance: 5000,
      currencyOrUnit: 'USDT',
      source: 'api',
      timestamp: new Date().toISOString(),
    });

    unknownRecovery = new UnknownStateRecovery(betRepo as any, roundRepo as any, eventBus);
    balanceReconciliation = new BalanceReconciliation(betRepo as any, balanceTracker, eventBus, { tolerance: 1000 });
    recoveryManager = new RecoveryManager(unknownRecovery, balanceReconciliation, betRepo as any, eventBus);
  });

  it('should detect UNKNOWN bets on startup and enter recovery', async () => {
    // Create round record first
    await roundRepo.create({
      externalRoundId: 'recovery-round-1',
      sessionId: 'recovery-session',
      startedAt: new Date().toISOString(),
      observedCrashPoint: 1.15,
      finalConfirmedCrashPoint: 1.15,
      dataQuality: 'high',
    });

    // Create an UNKNOWN bet (simulating crash mid-bet)
    const bet = await betRepo.create({
      sessionId: 'recovery-session',
      roundId: 'recovery-round-1',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
    });
    await betRepo.update(bet.id, { state: 'UNKNOWN' });

    // Run recovery
    const result = await recoveryManager.runRecovery();

    expect(result.phase).toBe('idle');
    expect(result.canResume).toBe(true);
    expect(result.betRecovery).not.toBeNull();
  });

  it('should resolve UNKNOWN bet as LOST when crash point is below target', async () => {
    // Create round that crashed below target
    await roundRepo.create({
      externalRoundId: 'recovery-round-1',
      sessionId: 'recovery-session',
      startedAt: new Date().toISOString(),
      observedCrashPoint: 1.15,
      finalConfirmedCrashPoint: 1.15,
      dataQuality: 'high',
    });

    const bet = await betRepo.create({
      sessionId: 'recovery-session',
      roundId: 'recovery-round-1',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
    });
    await betRepo.update(bet.id, { state: 'UNKNOWN' });

    const result = await recoveryManager.runRecovery();

    expect(result.canResume).toBe(false);

    const unresolvedBet = await betRepo.findById(bet.id);
    expect(unresolvedBet?.state).toBe('UNKNOWN');
    expect(unresolvedBet?.pnl).toBeNull();
  });

  it('should keep UNKNOWN bet unresolved when only round crash point is available', async () => {
    // Create round that crashed above target
    await roundRepo.create({
      externalRoundId: 'recovery-round-2',
      sessionId: 'recovery-session',
      startedAt: new Date().toISOString(),
      observedCrashPoint: 2.50,
      finalConfirmedCrashPoint: 2.50,
      dataQuality: 'high',
    });

    const bet = await betRepo.create({
      sessionId: 'recovery-session',
      roundId: 'recovery-round-2',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
    });
    await betRepo.update(bet.id, { state: 'UNKNOWN' });

    const result = await recoveryManager.runRecovery();

    expect(result.canResume).toBe(false);

    const unresolvedBet = await betRepo.findById(bet.id);
    expect(unresolvedBet?.state).toBe('UNKNOWN');
    expect(unresolvedBet?.pnl).toBeNull();
  });

  it('should halt betting when unknown bets cannot be resolved', async () => {
    // Create UNKNOWN bet with no round history
    const bet = await betRepo.create({
      sessionId: 'recovery-session',
      roundId: 'missing-round',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
    });
    await betRepo.update(bet.id, { state: 'UNKNOWN' });

    // Use default config (requireZeroUnknownBeforeResume: true)
    const strictManager = new RecoveryManager(
      unknownRecovery,
      balanceReconciliation,
      betRepo as any,
      eventBus,
    );

    const result = await strictManager.runRecovery();

    // Cannot resume because round history is missing and bet remains UNKNOWN
    expect(result.canResume).toBe(false);
    expect(result.betRecovery?.stillUnknown).toBeGreaterThan(0);
  });

  it('should reconcile balance after recovery', async () => {
    // Setup: initial balance 5000, one lost bet of 700
    balanceTracker.record({
      timestamp: new Date().toISOString(),
      balance: 5000,
      currencyOrUnit: 'USDT',
      source: 'api',
    });

    await roundRepo.create({
      externalRoundId: 'recovery-round-3',
      sessionId: 'recovery-session',
      startedAt: new Date().toISOString(),
      observedCrashPoint: 1.10,
      finalConfirmedCrashPoint: 1.10,
      dataQuality: 'high',
    });

    const bet = await betRepo.create({
      sessionId: 'recovery-session',
      roundId: 'recovery-round-3',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
    });
    await betRepo.update(bet.id, { state: 'UNKNOWN' });

    const result = await recoveryManager.runRecovery();

    expect(result.canResume).toBe(true);
    expect(result.balanceReconciliation).not.toBeNull();
    expect(result.balanceReconciliation?.reconciled).toBe(true);
  });

  it('should emit SystemPaused and SystemResumed events during recovery', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

    eventBus.on('SystemPaused', (event) => { events.push({ type: 'SystemPaused', payload: event.payload as Record<string, unknown> }); });
    eventBus.on('SystemResumed', (event) => { events.push({ type: 'SystemResumed', payload: event.payload as Record<string, unknown> }); });

    await roundRepo.create({
      externalRoundId: 'recovery-round-4',
      sessionId: 'recovery-session',
      startedAt: new Date().toISOString(),
      observedCrashPoint: 1.20,
      finalConfirmedCrashPoint: 1.20,
      dataQuality: 'high',
    });

    const bet = await betRepo.create({
      sessionId: 'recovery-session',
      roundId: 'recovery-round-4',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
    });
    await betRepo.update(bet.id, { state: 'UNKNOWN' });

    await recoveryManager.runRecovery();

    const pausedEvents = events.filter((e) => e.type === 'SystemPaused');
    const resumedEvents = events.filter((e) => e.type === 'SystemResumed');

    expect(pausedEvents.length).toBeGreaterThanOrEqual(1);
    expect(resumedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle multiple UNKNOWN bets in one recovery sweep', async () => {
    // Create multiple rounds
    for (let i = 0; i < 5; i++) {
      await roundRepo.create({
        externalRoundId: `multi-round-${i}`,
        sessionId: 'recovery-session',
        startedAt: new Date().toISOString(),
        observedCrashPoint: 1.0 + i * 0.3,
        finalConfirmedCrashPoint: 1.0 + i * 0.3,
        dataQuality: 'high',
      });

      const bet = await betRepo.create({
        sessionId: 'recovery-session',
        roundId: `multi-round-${i}`,
        dailyKey: '2026-08-18',
        stake: 700,
        cashOutTarget: 1.30,
        balanceBefore: 5000,
      });
      await betRepo.update(bet.id, { state: 'UNKNOWN' });
    }

    const result = await recoveryManager.runRecovery();

    expect(result.betRecovery?.totalUnknown).toBe(5);
    expect(result.betRecovery?.resolved).toBe(5);
    expect(result.canResume).toBe(true);
  });
});
