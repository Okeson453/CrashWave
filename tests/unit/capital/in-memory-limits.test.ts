import { InMemoryCapitalGuard } from '../../../src/capital/in-memory-limits';

describe('InMemoryCapitalGuard', () => {
  const base = {
    maxDrawdownAbs: 1000,
    maxDrawdownPct: 0.2,
    panicBalanceFloor: 100,
    maxStake: 700,
    startingBankroll: 5000,
  };

  it('allows bet within limits', () => {
    const g = new InMemoryCapitalGuard(base);
    expect(g.canPlaceBet(700).allowed).toBe(true);
  });

  it('rejects stake above max', () => {
    const g = new InMemoryCapitalGuard(base);
    const r = g.canPlaceBet(800);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/STAKE_EXCEEDS_MAX/);
  });

  it('locks on panic floor', () => {
    const g = new InMemoryCapitalGuard(base);
    g.updateBalance(50);
    expect(g.isLocked).toBe(true);
    expect(g.canPlaceBet(10).allowed).toBe(false);
  });

  it('locks on absolute drawdown', () => {
    const g = new InMemoryCapitalGuard(base);
    g.updateBalance(3500); // drawdown 1500 > 1000
    expect(g.isLocked).toBe(true);
  });

  it('locks on percent drawdown', () => {
    const g = new InMemoryCapitalGuard({ ...base, maxDrawdownAbs: 99999 });
    g.updateBalance(3900); // 22% > 20%
    expect(g.isLocked).toBe(true);
  });

  it('unlock requires operator ack', () => {
    const g = new InMemoryCapitalGuard(base);
    g.updateBalance(50);
    expect(g.isLocked).toBe(true);
    g.unlock('operator-1');
    expect(g.isLocked).toBe(false);
  });
});
