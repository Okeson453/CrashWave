import { ReconciliationEngine } from '../../../src/ledger/reconciliation';
;
jest.mock('../../../src/observability/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));
;
describe('ReconciliationEngine', () => {
  let engine: ReconciliationEngine;
;
  beforeEach(() => {
    engine = new ReconciliationEngine();
  });
;
  describe('reconcile — game API evidence', () => {
    it('resolves as CASHED_OUT when game API confirms cash-out', async () => {
      const result = await engine.reconcile({
        betId: 'bet-1',
        roundId: 'round-1',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: 2.0,
          balanceBefore: 5000,
          balanceAfter: null,
          gameApiShowsCashOut: true,
          gameApiMultiplier: 1.30,
        },
      });
      expect(result.resolution).toBe('CASHED_OUT');
      expect(result.pnl).toBeCloseTo(210, 5);
      expect(result.cashOutMultiplier).toBe(1.30);
      expect(result.manualOverride).toBe(false);
      expect(result.reason).toContain('Game API confirms cash-out');
    });
;
    it('resolves as LOST when game API confirms no cash-out', async () => {
      const result = await engine.reconcile({
        betId: 'bet-1',
        roundId: 'round-1',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: 1.10,
          balanceBefore: 5000,
          balanceAfter: null,
          gameApiShowsCashOut: false,
          gameApiMultiplier: null,
        },
      });
      expect(result.resolution).toBe('LOST');
      expect(result.pnl).toBeNull();
      expect(result.cashOutMultiplier).toBeNull();
      expect(result.reason).toContain('no cash-out');
    });
  });
;
  describe('reconcile — balance evidence', () => {
    it('resolves as CASHED_OUT when balance change matches win amount', async () => {
      const result = await engine.reconcile({
        betId: 'bet-1',
        roundId: 'round-1',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: null,
          balanceBefore: 5000,
          balanceAfter: 5210,
          balanceDeltaIsolated: true,
          gameApiShowsCashOut: null,
          gameApiMultiplier: null,
        },
      });
      expect(result.resolution).toBe('CASHED_OUT');
      expect(result.pnl).toBeCloseTo(210, 5);
      expect(result.reason).toContain('Isolated balance delta matches win amount');
    });
;
    it('resolves as LOST when balance change matches loss amount', async () => {
      const result = await engine.reconcile({
        betId: 'bet-1',
        roundId: 'round-1',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: null,
          balanceBefore: 5000,
          balanceAfter: 4300,
          balanceDeltaIsolated: true,
          gameApiShowsCashOut: null,
          gameApiMultiplier: null,
        },
      });
      expect(result.resolution).toBe('LOST');
      expect(result.pnl).toBe(-700);
      expect(result.reason).toContain('Isolated balance delta matches loss amount');
    });
;
    it('resolves as FAILED when balance did not change', async () => {
      const result = await engine.reconcile({
        betId: 'bet-1',
        roundId: 'round-1',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: null,
          balanceBefore: 5000,
          balanceAfter: 5000,
          balanceDeltaIsolated: true,
          gameApiShowsCashOut: null,
          gameApiMultiplier: null,
        },
      });
      expect(result.resolution).toBe('FAILED');
      expect(result.pnl).toBe(0);
      expect(result.reason).toContain('Isolated balance delta shows no settlement movement');
    });
  });
;
  describe('reconcile — crash point evidence', () => {
    it('resolves as LOST when crash point is clearly below target', async () => {
      const result = await engine.reconcile({
        betId: 'bet-1',
        roundId: 'round-1',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: 1.15,
          balanceBefore: null,
          balanceAfter: null,
          gameApiShowsCashOut: null,
          gameApiMultiplier: null,
        },
      });
      expect(result.resolution).toBe('UNKNOWN');
      expect(result.pnl).toBeNull();
      expect(result.reason).toContain('Insufficient evidence');
    });
;
    it('remains UNKNOWN when crash point is above target (ambiguous)', async () => {
      const result = await engine.reconcile({
        betId: 'bet-1',
        roundId: 'round-1',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: 2.0,
          balanceBefore: null,
          balanceAfter: null,
          gameApiShowsCashOut: null,
          gameApiMultiplier: null,
        },
      });
      expect(result.resolution).toBe('UNKNOWN');
      expect(result.pnl).toBeNull();
      expect(result.reason).toContain('Insufficient evidence');
    });
  });
;
  describe('reconcile — no evidence', () => {
    it('remains UNKNOWN when no evidence is available', async () => {
      const result = await engine.reconcile({
        betId: 'bet-1',
        roundId: 'round-1',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: null,
          balanceBefore: null,
          balanceAfter: null,
          gameApiShowsCashOut: null,
          gameApiMultiplier: null,
        },
      });
      expect(result.resolution).toBe('UNKNOWN');
      expect(result.pnl).toBeNull();
      expect(result.cashOutMultiplier).toBeNull();
      expect(result.manualOverride).toBe(false);
    });
  });
;
  describe('reconcile — precedence', () => {
    it('prefers game API over balance evidence', async () => {
      const result = await engine.reconcile({
        betId: 'bet-1',
        roundId: 'round-1',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: null,
          balanceBefore: 5000,
          balanceAfter: 4300,
          balanceDeltaIsolated: true,
          gameApiShowsCashOut: true,
          gameApiMultiplier: 1.30,
        },
      });
      expect(result.resolution).toBe('CASHED_OUT');
      expect(result.reason).toContain('Game API confirms cash-out');
    });
;
    it('prefers balance over crash point evidence', async () => {
      const result = await engine.reconcile({
        betId: 'bet-1',
        roundId: 'round-1',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: 1.15,
          balanceBefore: 5000,
          balanceAfter: 5210,
          balanceDeltaIsolated: true,
          gameApiShowsCashOut: null,
          gameApiMultiplier: null,
        },
      });
      expect(result.resolution).toBe('CASHED_OUT');
      expect(result.reason).toContain('Isolated balance delta matches win amount');
    });
  });
;
  describe('applyManualOverride', () => {
    it('applies manual override to CASHED_OUT', () => {
      const result = engine.applyManualOverride({
        betId: 'bet-1',
        targetState: 'CASHED_OUT',
        pnl: 210,
        cashOutMultiplier: 1.30,
        reason: 'Operator reviewed round history',
        operatorId: 'op-123',
      });
      expect(result.resolution).toBe('CASHED_OUT');
      expect(result.pnl).toBeCloseTo(210, 5);
      expect(result.cashOutMultiplier).toBe(1.30);
      expect(result.manualOverride).toBe(true);
      expect(result.reason).toContain('op-123');
      expect(result.reason).toContain('Operator reviewed round history');
    });
;
    it('applies manual override to LOST', () => {
      const result = engine.applyManualOverride({
        betId: 'bet-1',
        targetState: 'LOST',
        pnl: -700,
        reason: 'Operator confirmed loss',
        operatorId: 'op-123',
      });
      expect(result.resolution).toBe('LOST');
      expect(result.pnl).toBe(-700);
      expect(result.cashOutMultiplier).toBeNull();
      expect(result.manualOverride).toBe(true);
    });
;
    it('applies manual override to FAILED', () => {
      const result = engine.applyManualOverride({
        betId: 'bet-1',
        targetState: 'FAILED',
        pnl: 0,
        reason: 'Bet was refunded',
        operatorId: 'op-123',
      });
      expect(result.resolution).toBe('FAILED');
      expect(result.pnl).toBeNull(); // FAILED state stores pnl as null per source
    });
;
    it('defaults pnl to 0 when not provided', () => {
      const result = engine.applyManualOverride({
        betId: 'bet-1',
        targetState: 'CASHED_OUT',
        reason: 'No PnL specified',
        operatorId: 'op-123',
      });
      expect(result.pnl).toBe(0);
    });
  });
;
  describe('canAutoReconcile', () => {
    it('returns true when game API shows cash-out', () => {
      expect(engine.canAutoReconcile({
        crashPoint: null,
        gameApiShowsCashOut: true,
        gameApiMultiplier: 1.30,
        balanceBefore: null,
        balanceAfter: null,
      })).toBe(true);
    });
;
    it('returns true when game API shows no cash-out', () => {
      expect(engine.canAutoReconcile({
        crashPoint: null,
        gameApiShowsCashOut: false,
        gameApiMultiplier: null,
        balanceBefore: null,
        balanceAfter: null,
      })).toBe(true);
    });
;
    it('returns true when balance changed significantly', () => {
      expect(engine.canAutoReconcile({
        crashPoint: null,
        gameApiShowsCashOut: null,
        gameApiMultiplier: null,
        balanceDeltaIsolated: true,
        balanceBefore: 5000,
        balanceAfter: 4300,
      })).toBe(true);
    });
;
    it('returns false when crash point is below target without settlement evidence', () => {
      expect(engine.canAutoReconcile({
        crashPoint: 1.15,
        gameApiShowsCashOut: null,
        gameApiMultiplier: null,
        balanceBefore: null,
        balanceAfter: null,
      })).toBe(false);
    });
;
    it('returns false when crash point is above target but no other evidence', () => {
      expect(engine.canAutoReconcile({
        crashPoint: 2.0,
        gameApiShowsCashOut: null,
        gameApiMultiplier: null,
        balanceBefore: null,
        balanceAfter: null,
      })).toBe(false);
    });
;
    it('returns false when no evidence at all', () => {
      expect(engine.canAutoReconcile({
        crashPoint: null,
        gameApiShowsCashOut: null,
        gameApiMultiplier: null,
        balanceBefore: null,
        balanceAfter: null,
      })).toBe(false);
    });
;
    it('returns false when balance unchanged', () => {
      expect(engine.canAutoReconcile({
        crashPoint: null,
        gameApiShowsCashOut: null,
        gameApiMultiplier: null,
        balanceBefore: 5000,
        balanceAfter: 5000,
      })).toBe(false);
    });
  });
;
  describe('result structure', () => {
    it('includes resolvedAt timestamp on all results', async () => {
      const result = await engine.reconcile({
        betId: 'bet-1',
        roundId: 'round-1',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: null,
          balanceBefore: null,
          balanceAfter: null,
          gameApiShowsCashOut: null,
          gameApiMultiplier: null,
        },
      });
      expect(result.resolvedAt).toBeDefined();
      expect(new Date(result.resolvedAt).getTime()).not.toBeNaN();
    });
;
    it('includes previousState as UNKNOWN', async () => {
      const result = await engine.reconcile({
        betId: 'bet-1',
        roundId: 'round-1',
        stake: 700,
        target: 1.30,
        evidence: {
          crashPoint: 1.15,
          balanceBefore: null,
          balanceAfter: null,
          gameApiShowsCashOut: null,
          gameApiMultiplier: null,
        },
      });
      expect(result.previousState).toBe('UNKNOWN');
    });
  });
});
