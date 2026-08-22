import { DriftGuard } from '../../../src/settlement/drift-guard';
import type { AuthoritativeSettlementEngine } from '../../../src/settlement/authoritative-settlement-engine';

function mockEngine(): AuthoritativeSettlementEngine {
  return {
    getAccountBalance: async () => {
      await Promise.resolve();
      return 0;
    },
  } as unknown as AuthoritativeSettlementEngine;
}

describe('DriftGuard.evaluate', () => {
  it('passes within threshold', () => {
    const g = new DriftGuard(mockEngine(), async () => {
      await Promise.resolve();
      return 0;
    }, { threshold: 0.01, enabled: true, pollIntervalMs: 1000 });
    expect(g.evaluate(100.0, 100.005)).toBe(true);
    expect(g.isTripped).toBe(false);
  });

  it('trips when delta exceeds threshold', () => {
    let halted = false;
    const g = new DriftGuard(
      mockEngine(),
      async () => {
        await Promise.resolve();
        return 0;
      },
      { threshold: 0.0001, enabled: true, pollIntervalMs: 1000 },
      undefined,
      () => {
        halted = true;
      }
    );
    expect(g.evaluate(100, 101)).toBe(false);
    expect(g.isTripped).toBe(true);
    expect(halted).toBe(true);
  });
});
