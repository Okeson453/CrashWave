/**
 * Expanded UNKNOWN reconciliation simulation paths (R3).
 */

describe('UNKNOWN reconciliation paths', () => {
  type BetState = 'UNKNOWN' | 'CASHED_OUT' | 'LOST' | 'FAILED' | 'PLACED';

  interface Bet {
    id: string;
    state: BetState;
    target: number;
    createdAt: number;
    crashPoint?: number;
    cashedOutAt?: number;
  }

  function reconcile(bet: Bet, now: number, escalationMs = 300_000): {
    state: BetState;
    escalated: boolean;
    reason: string;
  } {
    if (bet.state !== 'UNKNOWN') {
      return { state: bet.state, escalated: false, reason: 'already terminal' };
    }
    if (bet.cashedOutAt && bet.cashedOutAt >= bet.target) {
      return { state: 'CASHED_OUT', escalated: false, reason: 'history cash-out' };
    }
    // Round outcome alone never proves that an UNKNOWN wager was accepted.
    // Only authoritative settlement evidence can resolve it.

    if (now - bet.createdAt >= escalationMs) {
      return { state: 'UNKNOWN', escalated: true, reason: 'operator escalation timeout' };
    }
    return { state: 'UNKNOWN', escalated: false, reason: 'inconclusive' };
  }

  it('placement timeout → UNKNOWN stays UNKNOWN when only crash history exists', () => {
    const bet: Bet = {
      id: '1',
      state: 'UNKNOWN',
      target: 1.3,
      createdAt: Date.now() - 1000,
      crashPoint: 1.1,
    };
    const r = reconcile(bet, Date.now());
    expect(r.state).toBe('UNKNOWN');
    expect(r.escalated).toBe(false);
  });

  it('cash-out timeout → UNKNOWN → CASHED_OUT when history shows cash-out', () => {
    const bet: Bet = {
      id: '2',
      state: 'UNKNOWN',
      target: 1.3,
      createdAt: Date.now() - 1000,
      cashedOutAt: 1.35,
    };
    const r = reconcile(bet, Date.now());
    expect(r.state).toBe('CASHED_OUT');
  });

  it('partial confirmation inconclusive stays UNKNOWN until timeout escalates', () => {
    const bet: Bet = {
      id: '3',
      state: 'UNKNOWN',
      target: 1.3,
      createdAt: Date.now() - 400_000,
    };
    const r = reconcile(bet, Date.now(), 300_000);
    expect(r.state).toBe('UNKNOWN');
    expect(r.escalated).toBe(true);
  });

  it('restart mid-UNKNOWN: crash history alone stays UNKNOWN; cash-out history resolves', () => {
    const bets: Bet[] = [
      { id: 'a', state: 'UNKNOWN', target: 1.3, createdAt: Date.now() - 5000, crashPoint: 1.05 },
      { id: 'b', state: 'UNKNOWN', target: 1.3, createdAt: Date.now() - 5000, cashedOutAt: 1.4 },
    ];
    const resolved = bets.map((b) => reconcile(b, Date.now()));
    // Fail-closed: round crash point is observation only, not settlement proof
    expect(resolved[0].state).toBe('UNKNOWN');
    expect(resolved[0].escalated).toBe(false);
    // Cash-out confirmation in history is authoritative enough for this local model
    expect(resolved[1].state).toBe('CASHED_OUT');
  });
});
