import { BetExecutor, MockBetPlacementAdapter } from '../../../src/betting/executor';
import { InMemoryIdempotencyStore } from '../../../src/betting/idempotency';
import { PlaceBetRequest } from '../../../src/betting/types';

describe('Simulation: Failed Bet Placement', () => {
  let adapter: MockBetPlacementAdapter;
  let idempotency: InMemoryIdempotencyStore;

  const baseRequest: PlaceBetRequest = {
    betId: 'bet-1',
    roundId: 'round-1',
    sessionId: 'session-1',
    stake: 700,
    target: 1.30,
    idempotencyKey: 'idem-1',
    dryRun: false,
  };

  beforeEach(() => {
    adapter = new MockBetPlacementAdapter();
    idempotency = new InMemoryIdempotencyStore();
  });

  afterEach(() => {
    idempotency.clear();
    idempotency.dispose();
  });

  it('fails when adapter rejects submission', async () => {
    adapter.setBehavior({ shouldFailSubmission: true });
    const executor = new BetExecutor(adapter, idempotency, {
      placementTimeoutMs: 1000,
      maxPlacementRetries: 0,
      placementRetryDelayMs: 50,
    });

    const result = await executor.placeBet(baseRequest);
    expect(result.placed).toBe(false);
    expect(result.state).toBe('FAILED');
    expect(result.error).toContain('rejected');
  });

  it('fails after all retries exhausted', async () => {
    adapter.setBehavior({ shouldFailSubmission: true });
    const executor = new BetExecutor(adapter, idempotency, {
      placementTimeoutMs: 500,
      maxPlacementRetries: 2,
      placementRetryDelayMs: 50,
    });

    const result = await executor.placeBet(baseRequest);
    expect(result.placed).toBe(false);
    expect(result.retryCount).toBe(2);
    expect(result.error).toBeTruthy();
  });

  it('marks idempotency key as failed', async () => {
    adapter.setBehavior({ shouldFailSubmission: true });
    const executor = new BetExecutor(adapter, idempotency, {
      placementTimeoutMs: 500,
      maxPlacementRetries: 0,
      placementRetryDelayMs: 50,
    });

    await executor.placeBet(baseRequest);
    const record = await idempotency.getRecord('session-1', 'round-1');
    expect(record?.status).toBe('FAILED');
  });

  it('prevents retry with same idempotency key', async () => {
    adapter.setBehavior({ shouldFailSubmission: true });
    const executor = new BetExecutor(adapter, idempotency, {
      placementTimeoutMs: 500,
      maxPlacementRetries: 0,
      placementRetryDelayMs: 50,
    });

    await executor.placeBet(baseRequest);
    // Second attempt should be blocked
    const result = await executor.placeBet(baseRequest);
    expect(result.placed).toBe(false);
    expect(result.error).toContain('Duplicate');
  });
});
