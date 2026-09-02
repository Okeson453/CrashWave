/**
 * Personal-use dry-run controller + virtual ledger wiring.
 * Verifies spec §7.1: one round, one decision; round started → decision
 * → ENTER → virtual trade opened; round crashed → WIN/LOSS resolved;
 * balance, win rate, drawdown converge.
 */
import { DryRunController } from '../../../src/core/dry-run/dry-run-controller';
import { VirtualTradeLedger } from '../../../src/core/dry-run/virtual-ledger';
import type { DryRunSignal } from '../../../src/core/dry-run/dry-run-controller';

function makeSignal(overrides: Partial<DryRunSignal> = {}): DryRunSignal {
  return {
    signalId: 'sig-1',
    predictionId: 'pred-1',
    roundId: 'round-1',
    target: 1.30,
    probability: 0.9,
    confidence: 0.9,
    ...overrides,
  };
}

describe('dry-run personal-use (core/dry-run)', () => {
  let ledger: VirtualTradeLedger;
  let ctl: DryRunController;

  beforeEach(() => {
    ledger = new VirtualTradeLedger(10000);
    // Threshold at 0.5 so a 0.9 default signal qualifies and a 0.1 override
    // is rejected.
    ctl = new DryRunController({
      stake: 100,
      target: 1.30,
      minProbability: 0.5,
      minConfidence: 0.5,
    });
    // @ts-expect-error test injection (the controller normally owns its ledger)
    ctl.ledger = ledger;
    ctl.start('test-session');
  });

  it('opens a virtual trade when a signal qualifies', () => {
    const r = ctl.evaluateAndSimulate(makeSignal());
    expect(r.accepted).toBe(true);
    expect(ledger.getBalance()).toBe(10000 - 100);
  });

  it('rejects signals below the probability threshold', () => {
    const r = ctl.evaluateAndSimulate(makeSignal({ probability: 0.1, signalId: 'low' }));
    expect(r.accepted).toBe(false);
    expect(ledger.getBalance()).toBe(10000);
  });

  it('resolves a WIN when crash point >= target', () => {
    ctl.evaluateAndSimulate(makeSignal({ roundId: 'r-W', signalId: 'w' }));
    ctl.onRoundCompleted('r-W', 2.0);
    const snap = ledger.snapshot();
    expect(snap.wins).toBe(1);
    expect(snap.losses).toBe(0);
    // stake * (target - 1) = 100 * 0.3 = 30
    expect(snap.netPnl).toBeCloseTo(30, 5);
  });

  it('resolves a LOSS when crash point < target', () => {
    ctl.evaluateAndSimulate(makeSignal({ roundId: 'r-L', signalId: 'l' }));
    ctl.onRoundCompleted('r-L', 1.10);
    const snap = ledger.snapshot();
    expect(snap.wins).toBe(0);
    expect(snap.losses).toBe(1);
    expect(snap.netPnl).toBeCloseTo(-100, 5);
  });

  it('tracks win rate across many rounds', () => {
    let wins = 0;
    let losses = 0;
    for (let i = 0; i < 10; i++) {
      const r = ctl.evaluateAndSimulate(makeSignal({
        signalId: `sig-${i}`, predictionId: `p-${i}`, roundId: `r-${i}`,
      }));
      if (r.accepted) {
        const win = i % 2 === 0;
        ctl.onRoundCompleted(`r-${i}`, win ? 2.0 : 1.0);
        if (win) wins++; else losses++;
      }
    }
    const snap = ledger.snapshot();
    expect(snap.trades).toBe(10);
    expect(snap.wins).toBe(wins);
    expect(snap.losses).toBe(losses);
    expect(snap.winRate).toBeCloseTo(wins / 10, 2);
  });

  it('rejects duplicate signals idempotently', () => {
    const sig = makeSignal({ signalId: 'dup', predictionId: 'p', roundId: 'r' });
    const r1 = ctl.evaluateAndSimulate(sig);
    const r2 = ctl.evaluateAndSimulate(sig);
    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(false);
    expect(String(r2.reason ?? '').toLowerCase()).toMatch(/duplicate|insufficient/);
  });
});