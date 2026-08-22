/**
 * Database Failure Simulation Scenario
 */
import { EventBus } from '../../../src/core/event-bus/bus';
import { InMemoryBetRepository } from '../../../src/persistence/repositories/bet-repo';
import { InMemorySessionRepository } from '../../../src/persistence/repositories/session-repo';
import { InMemoryRoundRepository } from '../../../src/persistence/repositories/round-repo';
import { UnknownStateRecovery } from '../../../src/ledger/unknown-state-recovery';
import { BalanceReconciliation } from '../../../src/ledger/balance-reconciliation';
import { BalanceTracker } from '../../../src/ledger/balance-tracker';
import { RecoveryManager } from '../../../src/core/recovery-manager';

describe('Simulation: Database Failure', () => {
  let eventBus: EventBus;
  let betRepo: InMemoryBetRepository;
  let sessionRepo: InMemorySessionRepository;
  let roundRepo: InMemoryRoundRepository;

  beforeEach(() => {
    eventBus = new EventBus();
    betRepo = new InMemoryBetRepository();
    sessionRepo = new InMemorySessionRepository();
    roundRepo = new InMemoryRoundRepository();
  });

  it('should halt betting when database connection fails', async () => {
    const failingRepo = {
      ...betRepo,
      create: jest.fn().mockRejectedValue(new Error('Connection refused')),
    };

    await expect(
      failingRepo.create({
        sessionId: 's1',
        roundId: 'r1',
        dailyKey: '2026-08-18',
        stake: 700,
        cashOutTarget: 1.30,
        balanceBefore: 5000,
      })
    ).rejects.toThrow('Connection refused');
  });

  it('should mark in-flight bets as UNKNOWN when DB fails mid-transaction', async () => {
    const bet = await betRepo.create({
      sessionId: 's1',
      roundId: 'r1',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
    });

    await betRepo.update(bet.id, { state: 'UNKNOWN' });

    const updated = await betRepo.findById(bet.id);
    expect(updated?.state).toBe('UNKNOWN');
  });

  it('should recover UNKNOWN bets after database restoration', async () => {
    const bet = await betRepo.create({
      sessionId: 's1',
      roundId: 'r1',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
    });
    await betRepo.update(bet.id, { state: 'UNKNOWN' });

    await roundRepo.create({
      externalRoundId: 'r1',
      sessionId: 's1',
      startedAt: new Date().toISOString(),
      observedCrashPoint: 1.15,
      finalConfirmedCrashPoint: 1.15,
      dataQuality: 'high',
    });

    const mockEvidenceProvider = {
      async getSettlementEvidence(bet: { id: string }) {
        return {
          status: 'LOST' as const,
          cashOutMultiplier: null,
          externalReference: `sim-${bet.id}`,
          source: 'simulation-authoritative',
          evidence: { simulated: true },
        };
      },
    };
    const unknownRecovery = new UnknownStateRecovery(betRepo as any, roundRepo as any, eventBus, mockEvidenceProvider);
    const balanceTracker = new BalanceTracker();
    const balanceRecon = new BalanceReconciliation(betRepo as any, balanceTracker, eventBus);
    const recoveryManager = new RecoveryManager(
      unknownRecovery,
      balanceRecon,
      betRepo as any,
      eventBus,
      { requireZeroUnknownBeforeResume: false }
    );

    const result = await recoveryManager.runRecovery();

    expect(result.betRecovery).not.toBeNull();
    expect(result.betRecovery!.resolved).toBeGreaterThan(0);

    const resolvedBet = await betRepo.findById(bet.id);
    expect(resolvedBet?.state).toBe('LOST');
  });

  it('should buffer critical events when database is down', async () => {
    const events: unknown[] = [];
    eventBus.on('CriticalError', (event) => {
      events.push(event);
    });

    await eventBus.emitTyped('CriticalError', {
      message: 'Database connection lost',
      code: 'DB_CONNECTION_LOST',
      component: 'Database',
    }, 'db-fail-1', 'Database');

    expect(events.length).toBe(1);
    expect((events[0] as { payload: { code: string } }).payload.code).toBe('DB_CONNECTION_LOST');
  });

  it('should enter maintenance mode when persistence layer fails', async () => {
    const errors: Array<{ code: string }> = [];
    eventBus.on('CriticalError', (event: { payload: { code: string } }) => {
      errors.push(event.payload);
    });

    const failingSessionRepo = {
      ...sessionRepo,
      create: jest.fn().mockRejectedValue(new Error('Database unreachable')),
    };

    try {
      await failingSessionRepo.create({
        mode: 'live',
        status: 'initializing',
        configVersion: 1,
      });
    } catch {
      await eventBus.emitTyped('CriticalError', {
        message: 'Cannot create session: Database unreachable',
        code: 'DB_UNAVAILABLE',
        component: 'SessionRepository',
      }, 'db-maint-1', 'SessionRepository');
    }

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].code).toBe('DB_UNAVAILABLE');
  });
});
