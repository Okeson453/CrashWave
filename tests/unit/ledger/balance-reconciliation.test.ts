import { BalanceReconciliation } from '../../../src/ledger/balance-reconciliation';
import { BalanceTracker } from '../../../src/ledger/balance-tracker';
import { BetRepository, BetRecord } from '../../../src/persistence/repositories/bet-repo';
import { EventBus } from '../../../src/core/event-bus/bus';

describe('BalanceReconciliation', () => {
  let reconciler: BalanceReconciliation;
  let mockRepo: jest.Mocked<BetRepository>;
  let mockTracker: jest.Mocked<BalanceTracker>;
  let mockBus: jest.Mocked<EventBus>;

  beforeEach(() => {
    mockRepo = {
      countByState: jest.fn().mockResolvedValue(0),
      findByState: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<BetRepository>;

    mockTracker = {
      getCurrentBalance: jest.fn().mockReturnValue(5000),
    } as unknown as jest.Mocked<BalanceTracker>;

    mockBus = {
      emitTyped: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn().mockResolvedValue(undefined),
      on: jest.fn().mockReturnValue(() => {}),
      once: jest.fn().mockReturnValue(undefined),
      listenerCount: jest.fn().mockReturnValue(0),
      removeAllListeners: jest.fn().mockReturnValue(undefined),
      getEventNames: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<EventBus>;

    reconciler = new BalanceReconciliation(mockRepo, mockTracker, mockBus, {
      tolerance: 0.01,
      maxUnresolvedBets: 0,
      emitAlerts: true,
      haltOnMismatch: false,
      significantMismatchThreshold: 100,
    });
  });

  describe('reconcile', () => {
    it('reports reconciled when balance matches within tolerance', async () => {
      mockRepo.findByState.mockResolvedValue([]);

      const result = await reconciler.reconcile(5000);
      expect(result.reconciled).toBe(true);
      expect(result.withinTolerance).toBe(true);
      expect(result.difference).toBe(0);
    });

    it('reports mismatch when balance is outside tolerance', async () => {
      mockRepo.findByState.mockResolvedValue([]);

      const result = await reconciler.reconcile(5100);
      expect(result.reconciled).toBe(false);
      expect(result.withinTolerance).toBe(false);
      expect(result.difference).toBe(100);
    });

    it('uses tracker balance when no explicit balance provided', async () => {
      mockTracker.getCurrentBalance.mockReturnValue(5000);
      mockRepo.findByState.mockResolvedValue([]);

      const result = await reconciler.reconcile();
      expect(result.actualBalance).toBe(5000);
    });

    it('is not reconciled when actual balance is unknown', async () => {
      mockTracker.getCurrentBalance.mockReturnValue(null);

      const result = await reconciler.reconcile();
      expect(result.reconciled).toBe(false);
      expect(result.withinTolerance).toBe(false);
    });

    it('counts unresolved bets', async () => {
      mockRepo.countByState.mockImplementation((state) => {
        if (state === 'UNKNOWN') return Promise.resolve(2);
        return Promise.resolve(0);
      });
      mockRepo.findByState.mockResolvedValue([]);

      const result = await reconciler.reconcile(5000);
      expect(result.unresolvedBets).toBe(2);
    });

    it('emits alert on mismatch', async () => {
      mockRepo.findByState.mockResolvedValue([]);

      await reconciler.reconcile(5100);
      expect(mockBus.emitTyped).toHaveBeenCalledWith(
        'CriticalError',
        expect.objectContaining({ code: 'BALANCE_MISMATCH' }),
        expect.any(String),
        'BalanceReconciliation'
      );
    });

    it('computes expected balance from settled bets', async () => {
      const settledBets: BetRecord[] = [
        {
          id: 'bet-1',
          sessionId: 's1',
          roundId: 'r1',
          dailyKey: '2024-01-01',
          stake: 700,
          cashOutTarget: 1.30,
          state: 'CASHED_OUT',
          requestedAt: null,
          placedAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
          cashOutRequestedAt: new Date().toISOString(),
          cashOutConfirmedAt: new Date().toISOString(),
          observedCashOutMultiplier: 1.30,
          confirmedCashOutMultiplier: 1.30,
          pnl: 210,
          balanceBefore: 5000,
          balanceAfter: null,
          failureReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'bet-2',
          sessionId: 's1',
          roundId: 'r2',
          dailyKey: '2024-01-01',
          stake: 700,
          cashOutTarget: 1.30,
          state: 'LOST',
          requestedAt: null,
          placedAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
          cashOutRequestedAt: null,
          cashOutConfirmedAt: null,
          observedCashOutMultiplier: 1.15,
          confirmedCashOutMultiplier: 1.15,
          pnl: -700,
          balanceBefore: null,
          balanceAfter: null,
          failureReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      mockRepo.findByState.mockImplementation((state) => {
        if (state === 'CASHED_OUT' || state === 'LOST') {
          return Promise.resolve(settledBets.filter((b) => b.state === state));
        }
        return Promise.resolve([]);
      });

      // Expected: 5000 + 210 - 700 = 4510
      const result = await reconciler.reconcile(4510);
      expect(result.reconciled).toBe(true);
      expect(result.expectedBalance).toBe(4510);
    });
  });

  describe('hasMismatch', () => {
    it('returns false before any reconciliation', () => {
      expect(reconciler.hasMismatch()).toBe(false);
    });

    it('returns true after mismatch detected', async () => {
      mockRepo.findByState.mockResolvedValue([]);
      await reconciler.reconcile(5100);
      expect(reconciler.hasMismatch()).toBe(true);
    });
  });

  describe('shouldHalt', () => {
    it('returns false initially', () => {
      expect(reconciler.shouldHalt()).toBe(false);
    });

    it('returns true after 3 consecutive mismatches', async () => {
      mockRepo.findByState.mockResolvedValue([]);
      await reconciler.reconcile(5100);
      await reconciler.reconcile(5100);
      await reconciler.reconcile(5100);
      expect(reconciler.shouldHalt()).toBe(true);
    });
  });
});
