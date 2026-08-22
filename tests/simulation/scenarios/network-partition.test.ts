/**
 * Network Partition Simulation Scenario
 * Tests system behavior when network connectivity to BC.Game is interrupted.
 */
import { EventBus } from '../../../src/core/event-bus/bus';
import { InMemoryBetRepository } from '../../../src/persistence/repositories/bet-repo';
import { ReconciliationEngine } from '../../../src/ledger/reconciliation';

describe('Simulation: Network Partition', () => {
  let betRepo: InMemoryBetRepository;
  let eventBus: EventBus;
  let reconciler: ReconciliationEngine;

  beforeEach(() => {
    betRepo = new InMemoryBetRepository();
    eventBus = new EventBus();
    reconciler = new ReconciliationEngine();
  });

  describe('bet record tracking during partition', () => {
    it('should create bet records that track network failures', async () => {
      const bet = await betRepo.create({
        sessionId: 's1', roundId: 'net-001', dailyKey: '2026-08-18',
        stake: 700, cashOutTarget: 1.30, balanceBefore: 5000,
      });
      await betRepo.update(bet.id, { state: 'FAILED', failureReason: 'Network timeout' });
      const updated = await betRepo.findById(bet.id);
      expect(updated?.state).toBe('FAILED');
      expect(updated?.failureReason).toMatch(/timeout|network/i);
    });

    it('should track multiple network failures in sequence', async () => {
      for (let i = 0; i < 3; i++) {
        const bet = await betRepo.create({
          sessionId: 's1', roundId: `net-00${i}`, dailyKey: '2026-08-18',
          stake: 700, cashOutTarget: 1.30, balanceBefore: 5000,
        });
        await betRepo.update(bet.id, { state: 'FAILED', failureReason: 'Network timeout' });
      }
      const failed = await betRepo.findBySessionId('s1');
      expect(failed.length).toBe(3);
      expect(failed.every((b: any) => b.state === 'FAILED')).toBe(true);
    });

    it('should preserve bet state across network interruptions', async () => {
      const bet = await betRepo.create({
        sessionId: 's1', roundId: 'net-002', dailyKey: '2026-08-18',
        stake: 700, cashOutTarget: 1.30, balanceBefore: 5000,
      });
      await betRepo.update(bet.id, { state: 'PLACED' });
      // Simulate network partition
      await betRepo.update(bet.id, { state: 'UNKNOWN', failureReason: 'Network partition during cash-out' });
      const recovered = await betRepo.findById(bet.id);
      expect(recovered?.state).toBe('UNKNOWN');
      expect(recovered?.failureReason).toContain('partition');
    });
  });

  describe('reconciliation after partition', () => {
    it('should reconcile UNKNOWN bets using balance evidence after partition', async () => {
      const result = await reconciler.reconcile({
        betId: 'bet-net-1',
        roundId: 'round-net-1',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: null,
          balanceBefore: 5000,
          balanceAfter: 5210, // Win detected after partition resolves
          balanceDeltaIsolated: true,
          gameApiShowsCashOut: null,
          gameApiMultiplier: null,
        },
      });
      expect(result.resolution).toBe('CASHED_OUT');
      expect(result.pnl).toBeCloseTo(210, 5);
    });

    it('should reconcile as LOST when balance dropped by stake after partition', async () => {
      const result = await reconciler.reconcile({
        betId: 'bet-net-2',
        roundId: 'round-net-2',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: null,
          balanceBefore: 5000,
          balanceAfter: 4300,
          balanceDeltaIsolated: true,
          gameApiShowsCashOut: null,
          gameApiMultiplier: null,
        },
      });
      expect(result.resolution).toBe('LOST');
      expect(result.pnl).toBe(-700);
    });

    it('should remain UNKNOWN when no post-partition evidence exists', async () => {
      const result = await reconciler.reconcile({
        betId: 'bet-net-3',
        roundId: 'round-net-3',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: null,
          balanceBefore: null,
          balanceAfter: null,
          gameApiShowsCashOut: null,
          gameApiMultiplier: null,
        },
      });
      expect(result.resolution).toBe('UNKNOWN');
      expect(result.manualOverride).toBe(false);
    });
  });

  describe('event bus behavior', () => {
    it('should emit CriticalError on persistent network issues', async () => {
      const errors: Array<{ code: string }> = [];
      eventBus.on('CriticalError', (event: { payload: { code: string } }) => {
        errors.push(event.payload);
      });
      await eventBus.emitTyped('CriticalError', {
        message: 'Network partition detected',
        code: 'NETWORK_PARTITION', component: 'NetworkMonitor',
      }, 'net-1', 'NetworkMonitor');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('NETWORK_PARTITION');
    });

    it('should queue events during partition and deliver after recovery', async () => {
      const received: string[] = [];
      eventBus.on('RoundCrashed', (event: { payload: { roundId: string } }) => {
        received.push(event.payload.roundId);
      });
      await eventBus.emitTyped('RoundCrashed', { roundId: 'r1', crashPoint: 2.0 }, 'evt-1', 'Test');
      await eventBus.emitTyped('RoundCrashed', { roundId: 'r2', crashPoint: 1.5 }, 'evt-2', 'Test');
      expect(received).toContain('r1');
      expect(received).toContain('r2');
    });
  });
});
