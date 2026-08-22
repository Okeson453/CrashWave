/**
 * Simulation: Emergency Stop Scenario
 *
 * Simulates an operator triggering the emergency stop while a bet
 * is active and a cash-out is pending.
 *
 * Expected outcome:
 *   - EmergencyStop halts all executors immediately.
 *   - Pending bets are cancelled (marked FAILED).
 *   - System state is preserved.
 *   - Operator is notified via alert event.
 *   - SystemPaused event is emitted.
 *   - Betting cannot resume until operator explicitly resets.
 */

import { EmergencyStop } from '../../../src/core/emergency-stop';
import { LiveBetExecutor } from '../../../src/betting/live-executor';
import { LiveCashOutExecutor } from '../../../src/betting/live-cashout';
import { BetRepository } from '../../../src/persistence/repositories/bet-repo';
import { EventBus } from '../../../src/core/event-bus/bus';

describe('Simulation: Emergency Stop', () => {
  it('halts executors, cancels pending bets, and preserves state', async () => {
    const mockRepo = {
      findByState: jest.fn().mockImplementation((state: string) => {
        if (state === 'PENDING') {
          return Promise.resolve([
            {
              id: 'bet-pending-1',
              sessionId: 's1',
              roundId: 'r1',
              dailyKey: '2024-01-01',
              stake: 700,
              cashOutTarget: 1.30,
              state: 'PENDING',
              balanceBefore: 5000,
              balanceAfter: null,
              pnl: null,
              requestedAt: null,
              placedAt: null,
              confirmedAt: null,
              cashOutRequestedAt: null,
              cashOutConfirmedAt: null,
              observedCashOutMultiplier: null,
              confirmedCashOutMultiplier: null,
              failureReason: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ]);
        }
        if (state === 'RESERVED') {
          return Promise.resolve([
            {
              id: 'bet-reserved-1',
              sessionId: 's1',
              roundId: 'r2',
              dailyKey: '2024-01-01',
              stake: 700,
              cashOutTarget: 1.30,
              state: 'RESERVED',
              balanceBefore: 5000,
              balanceAfter: null,
              pnl: null,
              requestedAt: null,
              placedAt: null,
              confirmedAt: null,
              cashOutRequestedAt: null,
              cashOutConfirmedAt: null,
              observedCashOutMultiplier: null,
              confirmedCashOutMultiplier: null,
              failureReason: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ]);
        }
        return Promise.resolve([]);
      }),
      updateState: jest.fn().mockResolvedValue(undefined),
      findActiveBets: jest.fn().mockResolvedValue([]),
      findUnknownBets: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<BetRepository>;

    const mockBus = {
      emitTyped: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn().mockResolvedValue(undefined),
      on: jest.fn().mockReturnValue(() => {}),
      once: jest.fn().mockReturnValue(undefined),
      listenerCount: jest.fn().mockReturnValue(0),
      removeAllListeners: jest.fn().mockReturnValue(undefined),
      getEventNames: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<EventBus>;

    const emergencyStop = new EmergencyStop(mockRepo, mockBus, {
      attemptCancelPending: true,
      preserveState: true,
      notifyOperator: true,
    });

    // Mock executors
    const mockLiveExecutor = { stop: jest.fn() } as unknown as LiveBetExecutor;
    const mockCashOutExecutor = { stop: jest.fn() } as unknown as LiveCashOutExecutor;

    // Trigger emergency stop
    const result = await emergencyStop.trigger(
      'Operator initiated emergency stop during active round',
      mockLiveExecutor,
      mockCashOutExecutor
    );

    // Verify stop was triggered
    expect(result.triggered).toBe(true);
    expect(emergencyStop.isTriggered()).toBe(true);

    // Verify executors were halted
    expect(mockLiveExecutor.stop).toHaveBeenCalled();
    expect(mockCashOutExecutor.stop).toHaveBeenCalled();

    // Verify pending bets were cancelled
    expect(mockRepo.updateState).toHaveBeenCalledWith(
      'bet-pending-1',
      'FAILED',
      'Cancelled by emergency stop'
    );
    expect(mockRepo.updateState).toHaveBeenCalledWith(
      'bet-reserved-1',
      'FAILED',
      'Cancelled by emergency stop'
    );

    // Verify state was preserved
    expect(result.preservedState).toBe(true);

    // Verify operator was notified
    expect(result.operatorNotified).toBe(true);

    // Verify events were emitted
    expect(mockBus.emitTyped).toHaveBeenCalledWith(
      'CriticalError',
      expect.objectContaining({
        code: 'EMERGENCY_STOP',
        component: 'EmergencyStop',
      }),
      expect.any(String),
      'EmergencyStop'
    );

    expect(mockBus.emitTyped).toHaveBeenCalledWith(
      'SystemPaused',
      expect.objectContaining({
        reason: expect.stringContaining('Emergency stop'),
        pausedBy: 'EmergencyStop',
      }),
      expect.any(String),
      'EmergencyStop'
    );

    // Verify reset transitions state correctly
    await emergencyStop.reset('operator-1');
    expect(emergencyStop.isTriggered()).toBe(false);
    expect(emergencyStop.getState()).toBe('armed');
  });
});
