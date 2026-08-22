import { SettlementPayloadSchema } from '../../../src/settlement/types';
import { SettlementEvidenceSchema } from '../../../src/settlement/evidence-provider';

describe('SettlementPayloadSchema', () => {
  it('accepts valid WIN payload', () => {
    const r = SettlementPayloadSchema.safeParse({
      clientOrderId: 'coid_1',
      status: 'WIN',
      grossPayout: 910,
      multiplier: 1.3,
      settledAt: Date.now(),
    });
    expect(r.success).toBe(true);
  });

  it('rejects multiplier < 1', () => {
    const r = SettlementPayloadSchema.safeParse({
      clientOrderId: 'x',
      status: 'LOSS',
      grossPayout: 0,
      multiplier: 0.5,
      settledAt: Date.now(),
    });
    expect(r.success).toBe(false);
  });
});

describe('SettlementEvidenceSchema', () => {
  it('parses operator history shape', () => {
    const r = SettlementEvidenceSchema.safeParse({
      clientOrderId: 'c1',
      status: 'WIN',
      multiplier: 1.3,
      grossPayout: 910,
      source: 'operator_history',
    });
    expect(r.success).toBe(true);
  });
});
