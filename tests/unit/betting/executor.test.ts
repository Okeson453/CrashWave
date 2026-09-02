import { BetExecutor, MockBetPlacementAdapter } from '../../../src/betting/executor';
import { InMemoryIdempotencyStore } from '../../../src/betting/idempotency';
import { PlaceBetRequest } from '../../../src/betting/types';
;
jest.mock('../../../src/observability/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));
;
describe('BetExecutor', () => {
  let adapter: MockBetPlacementAdapter;
  let idempotency: InMemoryIdempotencyStore;
  let executor: BetExecutor;
;
  const baseRequest: PlaceBetRequest = {
    betId: 'bet-1',
    roundId: 'round-1',
    sessionId: 'session-1',
    stake: 700,
    target: 1.30,
    idempotencyKey: 'key-1',
    dryRun: false,
  };
;
  beforeEach(() => {
    adapter = new MockBetPlacementAdapter();
    idempotency = new InMemoryIdempotencyStore();
    executor = new BetExecutor(adapter, idempotency);
  });
;
  afterEach(() => {
    idempotency.clear();
  });
;
  describe('initialization', () => {
    it('initializes with default config', () => {
      expect(executor.isBusy()).toBe(false);
      expect(executor.getMutexState()).toEqual({ locked: false });
    });
;
    it('accepts custom config', () => {
      const custom = new BetExecutor(adapter, idempotency, {
        stake: 500,
        target: 2.0,
        placementTimeoutMs: 5000,
        maxPlacementRetries: 5,
      });
      expect(custom).toBeDefined();
      expect(custom.isBusy()).toBe(false);
    });
  });
;
  describe('placeBet — success path', () => {
    it('places and confirms a bet successfully', async () => {
      const result = await executor.placeBet(baseRequest);
      expect(result.placed).toBe(true);
      expect(result.state).toBe('CONFIRMED');
      expect(result.attemptedAt).toBeDefined();
      expect(result.confirmedAt).toBeDefined();
      expect(result.retryCount).toBe(0);
      expect(result.error).toBeUndefined();
    });
;
    it('returns dry-run result without physical placement', async () => {
      const dryRunRequest = { ...baseRequest, dryRun: true };
      const result = await executor.placeBet(dryRunRequest);
      expect(result.placed).toBe(true);
      expect(result.state).toBe('CONFIRMED');
      expect(result.retryCount).toBe(0);
    });
;
    it('marks idempotency as completed after successful placement', async () => {
      await executor.placeBet(baseRequest);
      const record = await idempotency.getRecord(baseRequest.sessionId, baseRequest.roundId);
      expect(record).not.toBeNull();
      expect(record!.status).toBe('COMPLETED');
    });
  });
;
  describe('placeBet — idempotency', () => {
    it('blocks duplicate bet for same session+round', async () => {
      await executor.placeBet(baseRequest);
      const duplicate = await executor.placeBet(baseRequest);
      expect(duplicate.placed).toBe(false);
      expect(duplicate.state).toBe('FAILED');
      expect(duplicate.error).toContain('Duplicate bet attempt blocked');
    });
;
    it('allows different round id for same session', async () => {
      await executor.placeBet(baseRequest);
      const differentRound = { ...baseRequest, roundId: 'round-2', betId: 'bet-2' };
      const result = await executor.placeBet(differentRound);
      expect(result.placed).toBe(true);
      expect(result.state).toBe('CONFIRMED');
    });
  });
;
  describe('placeBet — retry logic', () => {
    it('retries on submission failure and succeeds on second attempt', async () => {
      let callCount = 0;
      adapter.submitBet = jest.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount > 1);
      });
      const result = await executor.placeBet(baseRequest);
      expect(result.placed).toBe(true);
      expect(result.state).toBe('CONFIRMED');
      expect(result.retryCount).toBeGreaterThanOrEqual(1);
      expect(adapter.submitBet).toHaveBeenCalledTimes(2);
    });
;
    it('retries on confirmation timeout and succeeds on retry', async () => {
      let confirmCallCount = 0;
      adapter.waitForConfirmation = jest.fn().mockImplementation(() => {
        confirmCallCount++;
        if (confirmCallCount === 1) {
          return Promise.resolve(false);
        }
        return Promise.resolve(true);
      });
      const result = await executor.placeBet(baseRequest);
      expect(result.placed).toBe(true);
      expect(result.state).toBe('CONFIRMED');
      expect(result.retryCount).toBeGreaterThanOrEqual(1);
    });
;
    it('fails permanently after all retries exhausted', async () => {
      adapter.setBehavior({ shouldConfirm: false });
      const customExecutor = new BetExecutor(adapter, idempotency, {
        maxPlacementRetries: 1,
        placementRetryDelayMs: 10,
      });
      const result = await customExecutor.placeBet(baseRequest);
      expect(result.placed).toBe(false);
      expect(result.state).toBe('FAILED');
      expect(result.retryCount).toBe(1);
      expect(result.error).toBeDefined();
    });
;
    it('fails immediately when adapter rejects submission every time', async () => {
      adapter.setBehavior({ shouldFailSubmission: true });
      const customExecutor = new BetExecutor(adapter, idempotency, {
        maxPlacementRetries: 0,
      });
      const result = await customExecutor.placeBet(baseRequest);
      expect(result.placed).toBe(false);
      expect(result.state).toBe('FAILED');
      expect(result.error).toContain('rejected');
    });
  });
;
  describe('placeBet — timeout handling', () => {
    it('fails when confirmation times out on every attempt', async () => {
      adapter.setBehavior({ confirmDelayMs: 20000 });
      const customExecutor = new BetExecutor(adapter, idempotency, {
        placementTimeoutMs: 50,
        maxPlacementRetries: 0,
      });
      const result = await customExecutor.placeBet(baseRequest);
      expect(result.placed).toBe(false);
      expect(result.state).toBe('FAILED');
      expect(result.error).toContain('timed out');
    });
  });
;
  describe('placeBet — error handling', () => {
    it('handles unexpected errors gracefully', async () => {
      adapter.submitBet = jest.fn().mockRejectedValue(new Error('Network explosion'));
      const result = await executor.placeBet(baseRequest);
      expect(result.placed).toBe(false);
      expect(result.state).toBe('FAILED');
      expect(result.error).toContain('Network explosion');
    });
;
    it('marks idempotency as failed after permanent failure', async () => {
      adapter.setBehavior({ shouldFailSubmission: true });
      const customExecutor = new BetExecutor(adapter, idempotency, {
        maxPlacementRetries: 0,
      });
      await customExecutor.placeBet(baseRequest);
      const record = await idempotency.getRecord(baseRequest.sessionId, baseRequest.roundId);
      expect(record).not.toBeNull();
      expect(record!.status).toBe('FAILED');
    });
  });
;
  describe('mutex behavior', () => {
    it('acquires mutex during bet placement', async () => {
      adapter.setBehavior({ confirmDelayMs: 100 });
      const promise = executor.placeBet(baseRequest);
      expect(executor.isBusy()).toBe(true);
      await promise;
      expect(executor.isBusy()).toBe(false);
    });
;
    it('serializes concurrent bet placement attempts', async () => {
      let activeCount = 0;
      let maxActive = 0;
      adapter.submitBet = jest.fn().mockImplementation(async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 50));
        activeCount--;
        return true;
      });
      const req1 = { ...baseRequest, betId: 'bet-1', roundId: 'round-1' };
      const req2 = { ...baseRequest, betId: 'bet-2', roundId: 'round-2' };
      const [r1, r2] = await Promise.all([
        executor.placeBet(req1),
        executor.placeBet(req2),
      ]);
      expect(r1.placed).toBe(true);
      expect(r2.placed).toBe(true);
      expect(maxActive).toBe(1);
    });
;
    it('releases mutex even when placement throws', async () => {
      adapter.submitBet = jest.fn().mockImplementation(() => {
        throw new Error('Boom');
      });
      await executor.placeBet(baseRequest);
      expect(executor.isBusy()).toBe(false);
    });
  });
;
  describe('edge cases', () => {
    it('handles zero-stake request gracefully', async () => {
      const zeroStake = { ...baseRequest, stake: 0 };
      const result = await executor.placeBet(zeroStake);
      expect(result.placed).toBe(true);
      expect(result.state).toBe('CONFIRMED');
    });
;
    it('handles very high target multiplier', async () => {
      const highTarget = { ...baseRequest, target: 100.0 };
      const result = await executor.placeBet(highTarget);
      expect(result.placed).toBe(true);
      expect(result.state).toBe('CONFIRMED');
    });
  });
});
;
describe('MockBetPlacementAdapter', () => {
  let adapter: MockBetPlacementAdapter;
;
  beforeEach(() => {
    adapter = new MockBetPlacementAdapter();
  });
;
  it('submits bet successfully by default', async () => {
    const result = await adapter.submitBet({} as PlaceBetRequest);
    expect(result).toBe(true);
  });
;
  it('fails submission when configured', async () => {
    adapter.setBehavior({ shouldFailSubmission: true });
    const result = await adapter.submitBet({} as PlaceBetRequest);
    expect(result).toBe(false);
  });
;
  it('confirms bet by default', async () => {
    const result = await adapter.waitForConfirmation('bet-1', 1000);
    expect(result).toBe(true);
  });
;
  it('rejects confirmation when configured', async () => {
    adapter.setBehavior({ shouldConfirm: false });
    const result = await adapter.waitForConfirmation('bet-1', 1000);
    expect(result).toBe(false);
  });
;
  it('honors confirm delay', async () => {
    adapter.setBehavior({ confirmDelayMs: 100 });
    const start = Date.now();
    await adapter.waitForConfirmation('bet-1', 5000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });
;
  it('requests cash-out successfully by default', async () => {
    const result = await adapter.requestCashOut('bet-1', 'round-1');
    expect(result).toBe(true);
  });
;
  it('returns cash-out result by default', async () => {
    const result = await adapter.waitForCashOutConfirmation('bet-1', 1000);
      expect(result.success).toBe(true);
      expect(result.multiplier).toBe(1.30);
      expect(result.pnl).toBe(210);
  });
;
  it('returns failure when cash-out fails', async () => {
    adapter.setBehavior({ cashOutSuccess: false });
    const result = await adapter.waitForCashOutConfirmation('bet-1', 1000);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
;
  it('returns custom cash-out multiplier and PnL', async () => {
    adapter.setBehavior({ cashOutMultiplier: 2.0, cashOutPnl: 700 });
    const result = await adapter.waitForCashOutConfirmation('bet-1', 1000);
    expect(result.multiplier).toBe(2.0);
    expect(result.pnl).toBe(700);
  });
});
