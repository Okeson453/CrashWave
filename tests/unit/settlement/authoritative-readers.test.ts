import {
  createAuthoritativeBetReader,
  createAuthoritativeCashOutReader,
} from '../../../src/settlement/authoritative-readers';
import type { SettlementEvidenceProvider, SettlementEvidence } from '../../../src/settlement/evidence-provider';

function mockProvider(ev: SettlementEvidence | null): SettlementEvidenceProvider {
  return {
    getEvidence: async () => {
      await Promise.resolve();
      return ev;
    },
  };
}

describe('authoritative readers', () => {
  it('bet reader confirms on PENDING', async () => {
    const reader = createAuthoritativeBetReader(
      mockProvider({
        clientOrderId: 'c1',
        status: 'PENDING',
        source: 'operator_history',
      }),
      () => 'c1'
    );
    const r = await reader('round1', 'sess1');
    expect(r?.confirmed).toBe(true);
  });

  it('cash-out reader confirms WIN with multiplier', async () => {
    const reader = createAuthoritativeCashOutReader(
      mockProvider({
        clientOrderId: 'c1',
        status: 'WIN',
        multiplier: 1.3,
        grossPayout: 910,
        source: 'operator_api',
      }),
      () => 'c1'
    );
    const r = await reader('bet1', 'round1');
    expect(r?.confirmed).toBe(true);
    expect(r?.multiplier).toBe(1.3);
  });

  it('returns null without client_order_id', async () => {
    const reader = createAuthoritativeBetReader(mockProvider(null), () => undefined);
    expect(await reader('r', 's')).toBeNull();
  });
});
