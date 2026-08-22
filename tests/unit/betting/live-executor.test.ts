import { LiveBetExecutor } from '../../../src/betting/live-executor';
import { ConfirmationObserver } from '../../../src/betting/confirmation';
import { ExecutionSafeguards } from '../../../src/betting/execution-safeguards';
import { BetRepository } from '../../../src/persistence/repositories/bet-repo';
import { EventBus } from '../../../src/core/event-bus/bus';
import { PlaceBetRequest } from '../../../src/betting/types';
import { Page } from 'playwright';

// Mock Playwright Page and Locator
const createMockPage = () => {
  const mockLocator = {
    first: jest.fn().mockReturnThis(),
    waitFor: jest.fn().mockResolvedValue(undefined),
    fill: jest.fn().mockResolvedValue(undefined),
    isDisabled: jest.fn().mockResolvedValue(false),
    click: jest.fn().mockResolvedValue(undefined),
    isVisible: jest.fn().mockResolvedValue(true),
    textContent: jest.fn().mockResolvedValue(''),
  };

  return {
    locator: jest.fn().mockReturnValue(mockLocator),
    evaluate: jest.fn().mockResolvedValue([]),
    evaluateOnNewDocument: jest.fn().mockResolvedValue(undefined),
  } as unknown as Page;
};

// Mock BetRepository
const createMockBetRepo = (): jest.Mocked<BetRepository> => ({
  create: jest.fn().mockImplementation((input) => Promise.resolve({
    id: input.id ?? 'bet-1',
    sessionId: input.sessionId ?? null,
    roundId: input.roundId ?? null,
    dailyKey: input.dailyKey,
    stake: input.stake,
    cashOutTarget: input.cashOutTarget,
    state: input.state ?? 'PENDING',
    requestedAt: null,
    placedAt: null,
    confirmedAt: null,
    cashOutRequestedAt: null,
    cashOutConfirmedAt: null,
    observedCashOutMultiplier: null,
    confirmedCashOutMultiplier: null,
    pnl: null,
    balanceBefore: input.balanceBefore ?? null,
    balanceAfter: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  update: jest.fn().mockImplementation((id, input) => Promise.resolve({
    id,
    sessionId: null,
    roundId: null,
    dailyKey: '2024-01-01',
    stake: 700,
    cashOutTarget: 1.30,
    state: input.state ?? 'PENDING',
    requestedAt: input.requestedAt ?? null,
    placedAt: input.placedAt ?? null,
    confirmedAt: input.confirmedAt ?? null,
    cashOutRequestedAt: input.cashOutRequestedAt ?? null,
    cashOutConfirmedAt: input.cashOutConfirmedAt ?? null,
    observedCashOutMultiplier: input.observedCashOutMultiplier ?? null,
    confirmedCashOutMultiplier: input.confirmedCashOutMultiplier ?? null,
    pnl: input.pnl ?? null,
    balanceBefore: null,
    balanceAfter: null,
    failureReason: input.failureReason ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  updateState: jest.fn().mockImplementation((id, state, reason) => Promise.resolve({
    id,
    sessionId: null,
    roundId: null,
    dailyKey: '2024-01-01',
    stake: 700,
    cashOutTarget: 1.30,
    state,
    requestedAt: null,
    placedAt: null,
    confirmedAt: null,
    cashOutRequestedAt: null,
    cashOutConfirmedAt: null,
    observedCashOutMultiplier: null,
    confirmedCashOutMultiplier: null,
    pnl: null,
    balanceBefore: null,
    balanceAfter: null,
    failureReason: reason ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  findById: jest.fn().mockResolvedValue(null),
  findByIdOrThrow: jest.fn().mockImplementation((id) => Promise.resolve({
    id,
    sessionId: 'session-1',
    roundId: 'round-1',
    dailyKey: '2024-01-01',
    stake: 700,
    cashOutTarget: 1.30,
    state: 'PENDING',
    requestedAt: null,
    placedAt: null,
    confirmedAt: null,
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
} as unknown as jest.Mocked<BetRepository>);

// Mock ConfirmationObserver
const createMockConfirmationObserver = (): jest.Mocked<ConfirmationObserver> => ({
  waitForBetPlaced: jest.fn().mockResolvedValue(true),
  waitForCashOut: jest.fn().mockResolvedValue(1.30),
  attachWebSocketListener: jest.fn().mockResolvedValue(undefined),
  clearWebSocketBuffer: jest.fn().mockResolvedValue(undefined),
} as unknown as jest.Mocked<ConfirmationObserver>);

// Mock ExecutionSafeguards
const createMockSafeguards = (): jest.Mocked<ExecutionSafeguards> => ({
  checkPreFlight: jest.fn().mockResolvedValue({ approved: true, currentBalance: 5000 }),
  checkPostFlight: jest.fn().mockResolvedValue({ valid: true }),
  getDailyKey: jest.fn().mockReturnValue('2024-01-01'),
} as unknown as jest.Mocked<ExecutionSafeguards>);

const createMockEventBus = (): jest.Mocked<EventBus> => ({
  emitTyped: jest.fn().mockResolvedValue(undefined),
  emit: jest.fn().mockResolvedValue(undefined),
  on: jest.fn().mockReturnValue(() => {}),
  once: jest.fn().mockReturnValue(undefined),
  listenerCount: jest.fn().mockReturnValue(0),
  removeAllListeners: jest.fn().mockReturnValue(undefined),
  getEventNames: jest.fn().mockReturnValue([]),
} as unknown as jest.Mocked<EventBus>);

const baseRequest: PlaceBetRequest = {
  betId: 'bet-1',
  roundId: 'round-1',
  sessionId: 'session-1',
  stake: 700,
  target: 1.30,
  idempotencyKey: 'idem-1',
  dryRun: false,
};

describe('LiveBetExecutor', () => {
  let executor: LiveBetExecutor;
  let mockPage: Page;
  let mockRepo: jest.Mocked<BetRepository>;
  let mockObserver: jest.Mocked<ConfirmationObserver>;
  let mockSafeguards: jest.Mocked<ExecutionSafeguards>;
  let mockBus: jest.Mocked<EventBus>;

  beforeEach(() => {
    mockPage = createMockPage();
    mockRepo = createMockBetRepo();
    mockObserver = createMockConfirmationObserver();
    mockSafeguards = createMockSafeguards();
    mockBus = createMockEventBus();

    executor = new LiveBetExecutor(
      mockPage,
      mockRepo,
      mockObserver,
      mockSafeguards,
      mockBus,
      {
        placementTimeoutMs: 5000,
        maxPlacementRetries: 1,
        placementRetryDelayMs: 100,
        postClickObservationDelayMs: 50,
      }
    );
  });

  describe('successful placement', () => {
    it('places a bet successfully with full confirmation', async () => {
      const result = await executor.placeLiveBet(baseRequest);
      expect(result.placed).toBe(true);
      expect(result.state).toBe('PLACED');
      expect(result.confirmedAt).not.toBeNull();
      expect(result.error).toBeNull();
    });

    it('creates a bet record in PENDING state before placement', async () => {
      await executor.placeLiveBet(baseRequest);
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          roundId: 'round-1',
          state: 'PENDING',
          stake: 700,
          cashOutTarget: 1.30,
        })
      );
    });

    it('updates bet record to PLACED after confirmation', async () => {
      await executor.placeLiveBet(baseRequest);
      expect(mockRepo.update).toHaveBeenCalledWith(
        'bet-1',
        expect.objectContaining({ state: 'PLACED' })
      );
    });

    it('emits BetPlaced event after confirmation', async () => {
      await executor.placeLiveBet(baseRequest);
      expect(mockBus.emitTyped).toHaveBeenCalledWith(
        'BetPlaced',
        expect.objectContaining({
          betId: 'bet-1',
          roundId: 'round-1',
          stake: 700,
          target: 1.30,
        }),
        'bet-1',
        'LiveBetExecutor'
      );
    });
  });

  describe('pre-flight rejection', () => {
    it('rejects when pre-flight check fails', async () => {
      mockSafeguards.checkPreFlight.mockResolvedValue({
        approved: false,
        reason: 'Insufficient balance',
        currentBalance: 100,
      });

      const result = await executor.placeLiveBet(baseRequest);
      expect(result.placed).toBe(false);
      expect(result.state).toBe('FAILED');
      expect(result.error).toContain('Insufficient balance');
    });

    it('does not create bet record when pre-flight fails', async () => {
      mockSafeguards.checkPreFlight.mockResolvedValue({
        approved: false,
        reason: 'Daily limit reached',
      });

      await executor.placeLiveBet(baseRequest);
      expect(mockRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('confirmation timeout', () => {
    it('marks bet UNKNOWN when confirmation times out', async () => {
      mockObserver.waitForBetPlaced.mockRejectedValue(
        new Error('timeout')
      );

      const result = await executor.placeLiveBet(baseRequest);
      expect(result.state).toBe('UNKNOWN');
      expect(mockRepo.update).toHaveBeenCalledWith(
        'bet-1',
        expect.objectContaining({ state: 'UNKNOWN' })
      );
    });

    it('does not emit BetPlaced on confirmation timeout (stays UNKNOWN)', async () => {
      mockObserver.waitForBetPlaced.mockRejectedValue(
        new Error('timeout')
      );

      const result = await executor.placeLiveBet(baseRequest);
      expect(result.state).toBe('UNKNOWN');
      expect(mockBus.emitTyped).not.toHaveBeenCalledWith(
        'BetPlaced',
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });
  });

  describe('retry logic', () => {
    it('does not retry when confirmation fails after click (UNKNOWN)', async () => {
      mockObserver.waitForBetPlaced.mockRejectedValue(new Error('confirmation timeout'));
      const result = await executor.placeLiveBet(baseRequest);
      expect(result.state).toBe('UNKNOWN');
      // Single attempt path — confirmation mock only called once
      expect(mockObserver.waitForBetPlaced).toHaveBeenCalledTimes(1);
    });
  });

  describe('mutex behavior', () => {
    it('is not busy before placement', () => {
      expect(executor.isBusy()).toBe(false);
    });

    it('is busy during placement', async () => {
      mockObserver.waitForBetPlaced.mockImplementation(() =>
        new Promise((resolve) => setTimeout(() => resolve(true), 200))
      );

      const promise = executor.placeLiveBet(baseRequest);
      await Promise.resolve(); // let microtasks run so mutex is acquired
      expect(executor.isBusy()).toBe(true);
      await promise;
      expect(executor.isBusy()).toBe(false);
    });

    it('releases mutex after failure', async () => {
      mockObserver.waitForBetPlaced.mockRejectedValue(new Error('fail'));
      await executor.placeLiveBet(baseRequest);
      expect(executor.isBusy()).toBe(false);
    });
  });

  describe('stop behavior', () => {
    it('rejects new bets after stop', async () => {
      executor.stop();
      const result = await executor.placeLiveBet(baseRequest);
      expect(result.placed).toBe(false);
      expect(result.state).toBe('FAILED');
      expect(result.error).toContain('stopped');
    });
  });
});
