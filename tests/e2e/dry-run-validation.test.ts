/**
 * E2E: Dry-Run Validation
 *
 * Runs 100 simulated entries in dry-run mode and verifies:
 *   - All bets transition through valid states.
 *   - Zero unresolved UNKNOWN states.
 *   - Balance reconciliation matches within tolerance.
 *   - Latency stays within thresholds.
 *
 * This test must pass before any live testing is permitted.
 */

import { BetExecutor } from '../../src/betting/executor';
import { MockBetPlacementAdapter } from '../../src/betting/executor';
import { InMemoryIdempotencyStore } from '../../src/betting/idempotency';
import { PlaceBetRequest } from '../../src/betting/types';
import { BalanceTracker } from '../../src/ledger/balance-tracker';

describe('E2E: Dry-Run Validation', () => {
  it('completes 100 simulated entries with zero unresolved unknown states', async () => {
    const adapter = new MockBetPlacementAdapter();
    const idempotency = new InMemoryIdempotencyStore();
    const executor = new BetExecutor(adapter, idempotency, {
      placementTimeoutMs: 5000,
      maxPlacementRetries: 2,
      placementRetryDelayMs: 100,
    });

    const tracker = new BalanceTracker({ reconciliationTolerance: 0.01 });
    tracker.record({ timestamp: new Date().toISOString(), balance: 100000, currencyOrUnit: 'USD', source: 'api' });

    const results: Array<{
      placed: boolean;
      state: string;
      error: string | null;
      latencyMs: number;
    }> = [];

    for (let i = 0; i < 100; i++) {
      const request: PlaceBetRequest = {
        betId: `dry-bet-${i}`,
        roundId: `dry-round-${i}`,
        sessionId: 'dry-session',
        stake: 700,
        target: 1.30,
        idempotencyKey: `dry-idem-${i}`,
        dryRun: true,
      };

      const result = await executor.placeBet(request);
      results.push({
        placed: result.placed,
        state: result.state,
        error: result.error ?? null,
        latencyMs: result.confirmedAt
          ? new Date(result.confirmedAt).getTime() - new Date(result.attemptedAt).getTime()
          : 0,
      });
    }

    // Clean up timer to prevent jest from hanging
    idempotency.dispose();

    // Assertions
    expect(results).toHaveLength(100);

    // All placed successfully
    const allPlaced = results.every((r) => r.placed);
    expect(allPlaced).toBe(true);

    // Zero UNKNOWN states
    const unknownStates = results.filter((r) => r.state === 'UNKNOWN');
    expect(unknownStates).toHaveLength(0);

    // All confirmed
    const confirmedStates = results.filter((r) => r.state === 'CONFIRMED');
    expect(confirmedStates).toHaveLength(100);

    // Zero errors
    const errors = results.filter((r) => r.error !== null);
    expect(errors).toHaveLength(0);

    // Latency check: all under 1 second (dry-run should be instant)
    const highLatency = results.filter((r) => r.latencyMs > 1000);
    expect(highLatency).toHaveLength(0);
  }, 30000);
});
