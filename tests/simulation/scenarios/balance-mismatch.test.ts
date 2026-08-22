/**
 * Simulation: Balance Mismatch Scenario
 *
 * Simulates a situation where the actual balance observed from the
 * game interface does not match the expected balance computed from
 * the ledger of settled bets.
 *
 * Expected outcome:
 *   - BalanceReconciliation detects the mismatch.
 *   - Alert is emitted to the operator.
 *   - After 3 consecutive mismatches, betting is halted.
 *   - SystemPaused event is emitted.
 */

import { BalanceReconciliation } from '../../../src/ledger/balance-reconciliation';
import { BalanceTracker } from '../../../src/ledger/balance-tracker';
import { BetRepository } from '../../../src/persistence/repositories/bet-repo';
import { EventBus } from '../../../src/core/event-bus/bus';

describe('Simulation: Balance Mismatch', () => {
  it('detects balance mismatch and escalates to halt', async () => {
    const mockRepo = {
      countByState: jest.fn().mockResolvedValue(0),
      findByState: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<BetRepository>;

    const tracker = new BalanceTracker({ reconciliationTolerance: 0.01 });
    tracker.record({ timestamp: new Date().toISOString(), balance: 5000, currencyOrUnit: 'USD', source: 'api' });

    const mockBus = {
      emitTyped: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn().mockResolvedValue(undefined),
      on: jest.fn().mockReturnValue(() => {}),
      once: jest.fn().mockReturnValue(undefined),
      listenerCount: jest.fn().mockReturnValue(0),
      removeAllListeners: jest.fn().mockReturnValue(undefined),
      getEventNames: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<EventBus>;

    const reconciler = new BalanceReconciliation(mockRepo, tracker, mockBus, {
      tolerance: 0.01,
      maxUnresolvedBets: 0,
      emitAlerts: true,
      haltOnMismatch: true,
      significantMismatchThreshold: 50,
    });

    // Simulate 3 consecutive reconciliations with a mismatch of 100 units
    const result1 = await reconciler.reconcile(5100);
    expect(result1.withinTolerance).toBe(false);
    expect(result1.difference).toBe(100);
    expect(reconciler.hasMismatch()).toBe(true);
    expect(reconciler.shouldHalt()).toBe(false);

    const result2 = await reconciler.reconcile(5100);
    expect(result2.withinTolerance).toBe(false);
    expect(reconciler.shouldHalt()).toBe(false);

    const result3 = await reconciler.reconcile(5100);
    expect(result3.withinTolerance).toBe(false);
    expect(reconciler.shouldHalt()).toBe(true);

    // Verify alert was emitted
    expect(mockBus.emitTyped).toHaveBeenCalledWith(
      'CriticalError',
      expect.objectContaining({ code: 'BALANCE_MISMATCH' }),
      expect.any(String),
      'BalanceReconciliation'
    );

    // Verify halt event was emitted on the 3rd mismatch
    expect(mockBus.emitTyped).toHaveBeenCalledWith(
      'SystemPaused',
      expect.objectContaining({
        reason: expect.stringContaining('Balance mismatch exceeded threshold'),
        pausedBy: 'BalanceReconciliation',
      }),
      expect.any(String),
      'BalanceReconciliation'
    );
  });
});
