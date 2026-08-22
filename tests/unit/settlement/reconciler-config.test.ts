import { SettlementPayloadSchema } from '../../../src/settlement/types';

describe('VOID payload for reconciler', () => {
  it('accepts VOID with grossPayout returning stake', () => {
    const r = SettlementPayloadSchema.safeParse({
      clientOrderId: 'coid_deadline',
      status: 'VOID',
      grossPayout: 700,
      multiplier: 1,
      settledAt: Date.now(),
      evidence: { reason: 'reconcile_deadline_exceeded' },
    });
    expect(r.success).toBe(true);
  });
});
