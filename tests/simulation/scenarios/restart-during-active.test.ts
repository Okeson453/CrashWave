/**
 * Simulation: Restart During Active Bet Scenario
 *
 * Simulates a system restart while a bet is in ACTIVE state.
 * The RecoveryManager must detect the active/unknown bets, halt
 * new betting, query round history, and resolve state before resuming.
 *
 * Expected outcome:
 *   - RecoveryManager detects UNKNOWN bets on startup.
 *   - System enters RECONCILING mode.
 *   - UnknownStateRecovery queries round history.
 *   - Bet is resolved (LOST if round crashed, RECONCILED if round ended above target).
 *   - BalanceReconciliation runs and passes.
 *   - System resumes only when canResume is true.
 */

import { RecoveryManager } from '../../../src/core/recovery-manager';
import { UnknownStateRecovery } from '../../../src/ledger/unknown-state-recovery';
import { BalanceReconciliation } from '../../../src/ledger/balance-reconciliation';
import { BalanceTracker } from '../../../src/ledger/balance-tracker';
import { BetRepository } from '../../../src/persistence/repositories/bet-repo';
import { RoundRepository } from '../../../src/persistence/repositories/round-repo';
import { EventBus } from '../../../src/core/event-bus/bus';

describe('Simulation: Restart During Active Bet', () => {
  it('recovers from restart with an active bet and resumes safely', async () => {
    const activeBet = {
      id: 'bet-active-1',
      sessionId: 's1',
      roundId: 'r-restart-1',
      dailyKey: '2024-01-01',
      stake: 700,
      cashOutTarget: 1.30,
      state: 'UNKNOWN',
      balanceBefore: 5000,
      balanceAfter: null,
      pnl: null,
      requestedAt: null,
      placedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      cashOutRequestedAt: null,
      cashOutConfirmedAt: null,
      observedCashOutMultiplier: null,
      confirmedCashOutMultiplier: null,
      failureReason: 'System restarted during active round',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    let unknownCount = 1;
    const mockBetRepo = {
      countByState: jest.fn().mockImplementation((state: string) => {
        if (state === 'UNKNOWN') return Promise.resolve(unknownCount);
        return Promise.resolve(0);
      }),
      findUnknownBets: jest.fn().mockResolvedValue([activeBet]),
      update: jest.fn().mockImplementation(() => {
        unknownCount = 0;
        return Promise.resolve(undefined);
      }),
      findByState: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<BetRepository>;

    const mockRoundRepo = {
      findById: jest.fn().mockImplementation((id: string) => {
        if (id === 'r-restart-1') {
          return Promise.resolve({
            id: 'r-restart-1',
            finalConfirmedCrashPoint: 1.15,
            startedAt: new Date().toISOString(),
            crashedAt: new Date().toISOString(),
            durationMs: 5000,
            createdAt: new Date().toISOString(),
          });
        }
        return Promise.resolve(null);
      }),
    } as unknown as jest.Mocked<RoundRepository>;

    const tracker = new BalanceTracker({ reconciliationTolerance: 0.01 });
    tracker.record({ timestamp: new Date().toISOString(), balance: 4300, currencyOrUnit: 'USD', source: 'api' });

    const mockBus = {
      emitTyped: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn().mockResolvedValue(undefined),
      on: jest.fn().mockReturnValue(() => {}),
      once: jest.fn().mockReturnValue(undefined),
      listenerCount: jest.fn().mockReturnValue(0),
      removeAllListeners: jest.fn().mockReturnValue(undefined),
      getEventNames: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<EventBus>;

    
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

    const unknownRecovery = new UnknownStateRecovery(mockBetRepo, mockRoundRepo, mockBus, mockEvidenceProvider);
    const balanceReconciliation = new BalanceReconciliation(mockBetRepo, tracker, mockBus, {
      tolerance: 0.01,
      maxUnresolvedBets: 0,
      emitAlerts: true,
      haltOnMismatch: false,
      significantMismatchThreshold: 100,
    });

    const recoveryManager = new RecoveryManager(
      unknownRecovery,
      balanceReconciliation,
      mockBetRepo,
      mockBus,
      {
        haltDuringRecovery: true,
        recoveryTimeoutMs: 60000,
        requireZeroUnknownBeforeResume: true,
        requireBalanceReconciliationBeforeResume: true,
      }
    );

    // Step 1: Run recovery on startup
    expect(recoveryManager.isHalted()).toBe(false);
    const result = await recoveryManager.runRecovery();

    // Step 2: Verify recovery entered reconciling mode
    expect(result.phase).toBe('idle');
    expect(result.canResume).toBe(true);

    // Step 3: Verify bet was resolved
    expect(result.betRecovery).not.toBeNull();
    expect(result.betRecovery!.resolved).toBe(1);
    expect(result.betRecovery!.stillUnknown).toBe(0);

    // Step 4: Verify balance reconciled
    expect(result.balanceReconciliation).not.toBeNull();
    expect(result.balanceReconciliation!.reconciled).toBe(true);

    // Step 5: Verify SystemResumed event was emitted
    expect(mockBus.emitTyped).toHaveBeenCalledWith(
      'SystemResumed',
      expect.objectContaining({ resumedBy: 'RecoveryManager' }),
      expect.any(String),
      'RecoveryManager'
    );

    // Step 6: Verify no errors
    expect(result.errors).toHaveLength(0);
  });
});
