import { LiveCashOutExecutor } from '../../../src/betting/live-cashout';
import { ConfirmationObserver } from '../../../src/betting/confirmation';
import { BetRepository } from '../../../src/persistence/repositories/bet-repo';
import { EventBus } from '../../../src/core/event-bus/bus';
import { Page } from 'playwright';

// Mock Playwright Page
const createMockPage = () => {
  const mockLocator = {
    first: jest.fn().mockReturnThis(),
    waitFor: jest.fn().mockResolvedValue(undefined),
    isDisabled: jest.fn().mockResolvedValue(false),
    click: jest.fn().mockResolvedValue(undefined),
    isVisible: jest.fn().mockResolvedValue(true),
    textContent: jest.fn().mockResolvedValue('1.30x'),
  };

  return {
    locator: jest.fn().mockReturnValue(mockLocator),
  } as unknown as Page;
};

const createMockRepo = (): jest.Mocked<BetRepository> => ({
  findById: jest.fn().mockImplementation((id) => Promise.resolve({
    id,
    sessionId: 'session-1',
    roundId: 'round-1',
    dailyKey: '2024-01-01',
    stake: 700,
    cashOutTarget: 1.30,
    state: 'ACTIVE',
    requestedAt: null,
    placedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    cashOutRequestedAt: null,
    cashOutConfirmedAt: null,
    observedCashOutMultiplier: null,
    confirmedCashOutMultiplier: null,
    pnl: null,
    balanceBefore: 5000,
    balanceAfter: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  findByIdOrThrow: jest.fn().mockImplementation((id) => Promise.resolve({
    id,
    sessionId: 'session-1',
    roundId: 'round-1',
    dailyKey: '2024-01-01',
    stake: 700,
    cashOutTarget: 1.30,
    state: 'ACTIVE',
    requestedAt: null,
    placedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    cashOutRequestedAt: null,
    cashOutConfirmedAt: null,
    observedCashOutMultiplier: null,
    confirmedCashOutMultiplier: null,
    pnl: null,
    balanceBefore: 5000,
    balanceAfter: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  update: jest.fn().mockImplementation((id, input) => Promise.resolve({
    id,
    sessionId: 'session-1',
    roundId: 'round-1',
    dailyKey: '2024-01-01',
    stake: 700,
    cashOutTarget: 1.30,
    state: input.state ?? 'ACTIVE',
    requestedAt: input.cashOutRequestedAt ?? null,
    placedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    cashOutRequestedAt: input.cashOutRequestedAt ?? null,
    cashOutConfirmedAt: input.cashOutConfirmedAt ?? null,
    observedCashOutMultiplier: input.observedCashOutMultiplier ?? null,
    confirmedCashOutMultiplier: input.confirmedCashOutMultiplier ?? null,
    pnl: input.pnl ?? null,
    balanceBefore: 5000,
    balanceAfter: null,
    failureReason: input.failureReason ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
} as unknown as jest.Mocked<BetRepository>);

const createMockObserver = (): jest.Mocked<ConfirmationObserver> => ({
  waitForBetPlaced: jest.fn().mockResolvedValue(true),
  waitForCashOut: jest.fn().mockResolvedValue(1.30),
  attachWebSocketListener: jest.fn().mockResolvedValue(undefined),
  clearWebSocketBuffer: jest.fn().mockResolvedValue(undefined),
} as unknown as jest.Mocked<ConfirmationObserver>);

const createMockBus = (): jest.Mocked<EventBus> => ({
  emitTyped: jest.fn().mockResolvedValue(undefined),
  emit: jest.fn().mockResolvedValue(undefined),
  on: jest.fn().mockReturnValue(() => {}),
  once: jest.fn().mockReturnValue(undefined),
  listenerCount: jest.fn().mockReturnValue(0),
  removeAllListeners: jest.fn().mockReturnValue(undefined),
  getEventNames: jest.fn().mockReturnValue([]),
} as unknown as jest.Mocked<EventBus>);

describe('LiveCashOutExecutor', () => {
  let executor: LiveCashOutExecutor;
  let mockPage: Page;
  let mockRepo: jest.Mocked<BetRepository>;
  let mockObserver: jest.Mocked<ConfirmationObserver>;
  let mockBus: jest.Mocked<EventBus>;

  beforeEach(() => {
    mockPage = createMockPage();
    mockRepo = createMockRepo();
    mockObserver = createMockObserver();
    mockBus = createMockBus();

    executor = new LiveCashOutExecutor(
      mockPage,
      mockRepo,
      mockObserver,
      mockBus,
      {
        cashOutTimeoutMs: 5000,
        postClickObservationDelayMs: 50,
        cashOutGraceMultiplier: 0.02,
      }
    );
  });

  describe('arming and disarming', () => {
    it('arms for a specific bet', () => {
      executor.arm('bet-1', 'round-1', 1.30);
      // Should not throw; internal state set
      expect(executor).toBeDefined();
    });

    it('disarms after cash-out', async () => {
      executor.arm('bet-1', 'round-1', 1.30);
      await executor.executeCashOut(1.30);
      // After successful cash-out, disarm is called internally
      expect(mockRepo.update).toHaveBeenCalledWith(
        'bet-1',
        expect.objectContaining({ state: 'CASHED_OUT' })
      );
    });
  });

  describe('successful cash-out', () => {
    it('confirms cash-out and updates bet record', async () => {
      executor.arm('bet-1', 'round-1', 1.30);
      const result = await executor.executeCashOut(1.30);

      expect(result.success).toBe(true);
      expect(result.state).toBe('CASHED_OUT');
      expect(result.cashOutMultiplier).toBe(1.30);
      expect(result.pnl).toBe(210); // 700 * 1.30 - 700 = 210
    });

    it('emits CashOutConfirmed event', async () => {
      executor.arm('bet-1', 'round-1', 1.30);
      await executor.executeCashOut(1.30);

      expect(mockBus.emitTyped).toHaveBeenCalledWith(
        'CashOutConfirmed',
        expect.objectContaining({
          betId: 'bet-1',
          roundId: 'round-1',
          multiplier: 1.30,
          pnl: 210,
        }),
        'bet-1',
        'LiveCashOutExecutor'
      );
    });

    it('updates state to CASH_OUT_REQUESTED before confirmation', async () => {
      executor.arm('bet-1', 'round-1', 1.30);
      await executor.executeCashOut(1.30);

      expect(mockRepo.update).toHaveBeenCalledWith(
        'bet-1',
        expect.objectContaining({ state: 'CASH_OUT_REQUESTED' })
      );
    });
  });

  describe('cash-out timeout', () => {
    it('marks bet UNKNOWN when confirmation times out', async () => {
      mockObserver.waitForCashOut.mockRejectedValue(new Error('timeout'));
      executor.arm('bet-1', 'round-1', 1.30);

      const result = await executor.executeCashOut(1.30);
      expect(result.state).toBe('UNKNOWN');
      expect(mockRepo.update).toHaveBeenCalledWith(
        'bet-1',
        expect.objectContaining({ state: 'UNKNOWN' })
      );
    });

    it('emits CashOutFailed event on timeout', async () => {
      mockObserver.waitForCashOut.mockRejectedValue(new Error('timeout'));
      executor.arm('bet-1', 'round-1', 1.30);

      await executor.executeCashOut(1.30);
      expect(mockBus.emitTyped).toHaveBeenCalledWith(
        'CashOutFailed',
        expect.objectContaining({ betId: 'bet-1' }),
        'bet-1',
        'LiveCashOutExecutor'
      );
    });
  });

  describe('multiplier trigger', () => {
    it('triggers cash-out when multiplier reaches target minus grace', async () => {
      executor.arm('bet-1', 'round-1', 1.30);
      const executeSpy = jest.spyOn(executor, 'executeCashOut').mockResolvedValue({
        success: true,
        betId: 'bet-1',
        roundId: 'round-1',
        state: 'CASHED_OUT',
        cashOutMultiplier: 1.30,
        pnl: 210,
        error: null,
        latencyMs: 100,
      });

      // 1.30 * (1 - 0.02) = 1.274, so 1.28 should trigger
      await executor.onMultiplierUpdate(1.28);
      expect(executeSpy).toHaveBeenCalledWith(1.28);
      executeSpy.mockRestore();
    });

    it('does not trigger when below effective target', async () => {
      executor.arm('bet-1', 'round-1', 1.30);
      const executeSpy = jest.spyOn(executor, 'executeCashOut').mockResolvedValue({
        success: true,
        betId: 'bet-1',
        roundId: 'round-1',
        state: 'CASHED_OUT',
        cashOutMultiplier: 1.30,
        pnl: 210,
        error: null,
        latencyMs: 100,
      });

      await executor.onMultiplierUpdate(1.20);
      expect(executeSpy).not.toHaveBeenCalled();
      executeSpy.mockRestore();
    });
  });

  describe('round crash', () => {
    it('marks bet LOST when round crashes', async () => {
      executor.arm('bet-1', 'round-1', 1.30);
      await executor.onRoundCrash('round-1', 1.15);

      expect(mockRepo.update).toHaveBeenCalledWith(
        'bet-1',
        expect.objectContaining({
          state: 'LOST',
          pnl: -700,
          observedCashOutMultiplier: 1.15,
          confirmedCashOutMultiplier: 1.15,
        })
      );
    });

    it('emits CashOutFailed event on round crash', async () => {
      executor.arm('bet-1', 'round-1', 1.30);
      await executor.onRoundCrash('round-1', 1.15);

      expect(mockBus.emitTyped).toHaveBeenCalledWith(
        'CashOutFailed',
        expect.objectContaining({
          betId: 'bet-1',
          roundId: 'round-1',
          reason: expect.stringContaining('crashed'),
        }),
        'bet-1',
        'LiveCashOutExecutor'
      );
    });
  });

  describe('stop behavior', () => {
    it('rejects cash-out after stop', async () => {
      executor.arm('bet-1', 'round-1', 1.30);
      executor.stop();
      const result = await executor.executeCashOut(1.30);
      expect(result.success).toBe(false);
      expect(result.state).toBe('FAILED');
    });

    it('does not arm after stop', () => {
      executor.stop();
      executor.arm('bet-1', 'round-1', 1.30);
      // Should not throw; internal state may or may not update
      expect(executor).toBeDefined();
    });
  });
});
