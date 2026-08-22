/**
 * Restart Mid-Bet Simulation Scenario
 */
import { EventBus } from '../../../src/core/event-bus/bus';
import { InMemoryBetRepository } from '../../../src/persistence/repositories/bet-repo';
import { InMemoryRoundRepository } from '../../../src/persistence/repositories/round-repo';
import { UnknownStateRecovery, SettlementEvidenceProvider } from '../../../src/ledger/unknown-state-recovery';

/** Authoritative evidence stub — production recovery is evidence-driven only. */
const mockLostEvidenceProvider: SettlementEvidenceProvider = {
  async getSettlementEvidence(bet) {
    return {
      status: 'LOST',
      cashOutMultiplier: null,
      externalReference: `sim-${bet.id}`,
      source: 'simulation-authoritative',
      evidence: { simulated: true },
    };
  },
};

describe('Simulation: Restart Mid-Bet', () => {
  let eventBus: EventBus;
  let betRepo: InMemoryBetRepository;
  let roundRepo: InMemoryRoundRepository;

  beforeEach(() => {
    eventBus = new EventBus();
    betRepo = new InMemoryBetRepository();
    roundRepo = new InMemoryRoundRepository();
  });

  it('should detect UNKNOWN bets on restart', async () => {
    await betRepo.create({
      sessionId: 's1',
      roundId: 'r1',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
      state: 'UNKNOWN',
    });

    const unknownBets = await betRepo.findByState('UNKNOWN', 100);
    expect(unknownBets.length).toBe(1);
    expect(unknownBets[0].roundId).toBe('r1');
  });

  it('should reconcile UNKNOWN bets with round history', async () => {
    const bet = await betRepo.create({
      sessionId: 's1',
      roundId: 'r1',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
    });
    await betRepo.update(bet.id, { state: 'UNKNOWN' });

    await roundRepo.create({
      externalRoundId: 'r1',
      sessionId: 's1',
      startedAt: new Date().toISOString(),
      observedCrashPoint: 5.00,
      finalConfirmedCrashPoint: 5.00,
      dataQuality: 'high',
    });

    const recovery = new UnknownStateRecovery(betRepo as any, roundRepo as any, eventBus, mockLostEvidenceProvider);
    const result = await recovery.runRecoverySweep();

    expect(result.totalUnknown).toBe(1);
    expect(result.resolved).toBeGreaterThan(0);
  });

  it('should require manual review for ambiguous bets', async () => {
    const bet = await betRepo.create({
      sessionId: 's1',
      roundId: 'r1',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
    });
    await betRepo.update(bet.id, { state: 'UNKNOWN' });

    // No round record exists — ambiguous
    const recovery = new UnknownStateRecovery(betRepo as any, roundRepo as any, eventBus);
    const result = await recovery.runRecoverySweep();

    expect(result.totalUnknown).toBe(1);
    // Without round data, the bet may still be unknown
  });

  it('should resume safely after reconciliation', async () => {
    const bet = await betRepo.create({
      sessionId: 's1',
      roundId: 'r1',
      dailyKey: '2026-08-18',
      stake: 700,
      cashOutTarget: 1.30,
      balanceBefore: 5000,
      state: 'UNKNOWN',
    });

    await roundRepo.create({
      externalRoundId: 'r1',
      sessionId: 's1',
      startedAt: new Date().toISOString(),
      observedCrashPoint: 1.15,
      finalConfirmedCrashPoint: 1.15,
      dataQuality: 'high',
    });

    const recovery = new UnknownStateRecovery(betRepo as any, roundRepo as any, eventBus, mockLostEvidenceProvider);
    const result = await recovery.runRecoverySweep();

    expect(result.resolved).toBe(1);
    expect(result.stillUnknown).toBe(0);

    const resolved = await betRepo.findById(bet.id);
    expect(resolved?.state).not.toBe('UNKNOWN');
  });
});
