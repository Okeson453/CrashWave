import {
  ClientOrderIdRegistry,
  ReconciliationService,
  type OrderStatus,
} from '../../../src/core/reconciliation-service';

describe('ClientOrderIdRegistry', () => {
  it('generates unique ids and tracks pending', () => {
    const reg = new ClientOrderIdRegistry();
    const a = reg.generate(700, 1.3);
    const b = reg.generate(700, 1.3);
    expect(a).not.toBe(b);
    expect(reg.has(a)).toBe(true);
    reg.release(a);
    expect(reg.has(a)).toBe(false);
  });
});

describe('ReconciliationService', () => {
  it('resolves cashed_out', async () => {
    const reg = new ClientOrderIdRegistry();
    const coid = reg.generate(700, 1.3);
    const reader = async (): Promise<OrderStatus> => ({
      clientOrderId: coid,
      status: 'cashed_out',
      multiplier: 1.3,
      pnl: 210,
    });
    const svc = new ReconciliationService(reader, reg);
    const r = await svc.reconcile(coid);
    expect(r.resolution).toBe('CASHED_OUT');
    expect(reg.has(coid)).toBe(false);
  });

  it('returns NOT_FOUND when empty', async () => {
    const reg = new ClientOrderIdRegistry();
    const svc = new ReconciliationService(async () => ({
      clientOrderId: 'x',
      status: 'not_found',
    }), reg);
    const r = await svc.reconcile();
    expect(r.resolution).toBe('NOT_FOUND');
  });
});
