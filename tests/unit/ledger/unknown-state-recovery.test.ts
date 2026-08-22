import { UnknownStateRecovery } from '../../../src/ledger/unknown-state-recovery';
import { CriticalError } from '../../../src/utils/errors';
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
const createMockBetRepo = (): any => ({
  findById: jest.fn(),
  findByIdOrThrow: jest.fn(),
  findUnknownBets: jest.fn().mockResolvedValue([]),
  create: jest.fn(),
  update: jest.fn().mockResolvedValue(undefined),
  findBySessionId: jest.fn(),
  findByRoundId: jest.fn(),
  findRecent: jest.fn(),
});
;
const createMockRoundRepo = (): any => ({
  findById: jest.fn(),
  create: jest.fn(),
  findByExternalId: jest.fn(),
  findRecent: jest.fn(),
  findBySessionId: jest.fn(),
  update: jest.fn(),
});
;
const createMockBus = (): any => ({
  emitTyped: jest.fn().mockResolvedValue(undefined),
  emit: jest.fn().mockResolvedValue(undefined),
  on: jest.fn().mockReturnValue(() => {}),
  once: jest.fn().mockReturnValue(undefined),
  listenerCount: jest.fn().mockReturnValue(0),
  removeAllListeners: jest.fn().mockReturnValue(undefined),
  getEventNames: jest.fn().mockReturnValue([]),
});
;
describe('UnknownStateRecovery', () => {
  let recovery: UnknownStateRecovery;
  let betRepo: any;
  let roundRepo: any;
  let eventBus: any;
;
  beforeEach(() => {
    betRepo = createMockBetRepo();
    roundRepo = createMockRoundRepo();
    eventBus = createMockBus();
    recovery = new UnknownStateRecovery(betRepo, roundRepo, eventBus);
  });
;
  describe('runRecoverySweep', () => {
    it('returns empty result when no unknown bets exist', async () => {
      betRepo.findUnknownBets.mockResolvedValue([]);
      const result = await recovery.runRecoverySweep();
      expect(result.totalUnknown).toBe(0);
      expect(result.resolved).toBe(0);
      expect(result.manualReviewRequired).toBe(0);
      expect(result.stillUnknown).toBe(0);
      expect(result.results).toEqual([]);
    });
;
    it('resolves a clear loss (crash below target)', async () => {
      betRepo.findUnknownBets.mockResolvedValue([createUnknownBet()]);
      roundRepo.findById.mockResolvedValue({
        id: 'round-1',
        externalRoundId: 'ext-1',
        sessionId: 'session-1',
        startedAt: new Date().toISOString(),
        crashedAt: new Date().toISOString(),
        observedCrashPoint: 1.15,
        finalConfirmedCrashPoint: 1.15,
        observationSource: 'websocket',
        dataQuality: 'high',
        createdAt: new Date().toISOString(),
      });
      const evidenceProvider = { getSettlementEvidence: jest.fn().mockResolvedValue({ status: 'LOST', cashOutMultiplier: null, externalReference: 'ext-bet-1', source: 'authoritative-api', evidence: { settled: true } }) };
      recovery = new UnknownStateRecovery(betRepo, roundRepo, eventBus, evidenceProvider);
      const result = await recovery.runRecoverySweep();
      expect(result.totalUnknown).toBe(1);
      expect(result.resolved).toBe(1);
      expect(result.stillUnknown).toBe(0);
      expect(betRepo.update).toHaveBeenCalledWith('bet-1', expect.objectContaining({ state: 'LOST', pnl: -700 }));
    });
;
    it('resolves a clear win (crash at/above target) as RECONCILED', async () => {
      betRepo.findUnknownBets.mockResolvedValue([createUnknownBet()]);
      roundRepo.findById.mockResolvedValue({
        id: 'round-1',
        externalRoundId: 'ext-1',
        sessionId: 'session-1',
        startedAt: new Date().toISOString(),
        crashedAt: new Date().toISOString(),
        observedCrashPoint: 2.50,
        finalConfirmedCrashPoint: 2.50,
        observationSource: 'websocket',
        dataQuality: 'high',
        createdAt: new Date().toISOString(),
      });
      const evidenceProvider = { getSettlementEvidence: jest.fn().mockResolvedValue({ status: 'CASHED_OUT', cashOutMultiplier: 1.30, externalReference: 'ext-bet-1', source: 'authoritative-api', evidence: { settled: true } }) };
      recovery = new UnknownStateRecovery(betRepo, roundRepo, eventBus, evidenceProvider);
      const result = await recovery.runRecoverySweep();
      expect(result.totalUnknown).toBe(1);
      expect(result.resolved).toBe(1);
      expect(betRepo.update).toHaveBeenCalledWith('bet-1', expect.objectContaining({ state: 'CASHED_OUT', pnl: 210 }));
    });
;
    it('leaves bet UNKNOWN when round history is inconclusive', async () => {
      betRepo.findUnknownBets.mockResolvedValue([createUnknownBet()]);
      roundRepo.findById.mockResolvedValue({
        id: 'round-1',
        externalRoundId: 'ext-1',
        sessionId: 'session-1',
        startedAt: new Date().toISOString(),
        crashedAt: new Date().toISOString(),
        observedCrashPoint: null,
        finalConfirmedCrashPoint: null,
        observationSource: 'websocket',
        dataQuality: 'low',
        createdAt: new Date().toISOString(),
      });
      const result = await recovery.runRecoverySweep();
      expect(result.totalUnknown).toBe(1);
      expect(result.resolved).toBe(0);
      expect(result.manualReviewRequired).toBe(1);
      expect(result.stillUnknown).toBe(1);
      expect(betRepo.update).not.toHaveBeenCalled();
      expect(eventBus.emitTyped).toHaveBeenCalledWith(
        'CriticalError',
        expect.objectContaining({ code: 'UNKNOWN_BETS_REMAINING' }),
        expect.any(String),
        'UnknownStateRecovery'
      );
    });
;
    it('skips sweep if already reconciling', async () => {
      betRepo.findUnknownBets.mockImplementation(() =>
        new Promise((resolve) => setTimeout(() => resolve([]), 100))
      );
      const p1 = recovery.runRecoverySweep();
      expect(recovery.isReconcilingNow()).toBe(true);
      const p2 = recovery.runRecoverySweep();
      const r2 = await p2;
      expect(r2.totalUnknown).toBe(0);
      await p1;
      expect(recovery.isReconcilingNow()).toBe(false);
    });
;
    it('emits CriticalError when unknown bets remain', async () => {
      betRepo.findUnknownBets.mockResolvedValue([createUnknownBet()]);
      roundRepo.findById.mockResolvedValue(null);
      await recovery.runRecoverySweep();
      expect(eventBus.emitTyped).toHaveBeenCalled();
    });
;
    it('throws CriticalError when sweep fails catastrophically', async () => {
      betRepo.findUnknownBets.mockRejectedValue(new Error('DB is down'));
      await expect(recovery.runRecoverySweep()).rejects.toThrow(CriticalError);
      expect(recovery.isReconcilingNow()).toBe(false);
    });
  });
;
  describe('recoverBet', () => {
    it('returns unresolved when bet has no roundId', async () => {
      const result = await recovery.recoverBet({ ...createUnknownBet(), roundId: '' });
      expect(result.resolved).toBe(false);
      expect(result.newState).toBe('UNKNOWN');
      expect(result.reason).toContain('no roundId');
    });
;
    it('returns unresolved when round is not found', async () => {
      roundRepo.findById.mockResolvedValue(null);
      const result = await recovery.recoverBet(createUnknownBet());
      expect(result.resolved).toBe(false);
      expect(result.reason).toContain('not found');
    });
;
    it('returns unresolved when round has no crash point', async () => {
      roundRepo.findById.mockResolvedValue({
        id: 'round-1',
        externalRoundId: 'ext-1',
        sessionId: 'session-1',
        startedAt: new Date().toISOString(),
        crashedAt: new Date().toISOString(),
        observedCrashPoint: null,
        finalConfirmedCrashPoint: null,
        observationSource: 'websocket',
        dataQuality: 'low',
        createdAt: new Date().toISOString(),
      });
      const result = await recovery.recoverBet(createUnknownBet());
      expect(result.resolved).toBe(false);
      expect(result.reason).toContain('no crash point');
    });
;
    it('handles errors gracefully and returns unresolved', async () => {
      roundRepo.findById.mockRejectedValue(new Error('DB timeout'));
      const result = await recovery.recoverBet(createUnknownBet());
      expect(result.resolved).toBe(false);
      expect(result.reason).toContain('Recovery error');
    });
  });
;
  it('never infers settlement from crash point alone', async () => {
    betRepo.findUnknownBets.mockResolvedValue([createUnknownBet()]);
    roundRepo.findById.mockResolvedValue({ id: 'round-1', finalConfirmedCrashPoint: 9.0, observedCrashPoint: 9.0 });
    const result = await recovery.runRecoverySweep();
    expect(result.resolved).toBe(0);
    expect(result.stillUnknown).toBe(1);
    expect(betRepo.update).not.toHaveBeenCalled();
  });

  describe('manualResolve', () => {
    it('resolves a bet to CASHED_OUT', async () => {
      betRepo.findById.mockResolvedValue(createUnknownBet());
      const result = await recovery.manualResolve('bet-1', 'CASHED_OUT', 210, 1.30, 'Operator confirmed');
      expect(result.resolved).toBe(true);
      expect(result.newState).toBe('CASHED_OUT');
      expect(result.pnl).toBe(210);
      expect(result.multiplier).toBe(1.30);
      expect(betRepo.update).toHaveBeenCalledWith('bet-1', expect.objectContaining({
        state: 'CASHED_OUT',
        pnl: 210,
      }));
    });
;
    it('resolves a bet to LOST', async () => {
      betRepo.findById.mockResolvedValue(createUnknownBet());
      const result = await recovery.manualResolve('bet-1', 'LOST', -700);
      expect(result.resolved).toBe(true);
      expect(result.newState).toBe('LOST');
      expect(result.pnl).toBe(-700);
    });
;
    it('throws when bet is not found', async () => {
      betRepo.findById.mockResolvedValue(null);
      await expect(recovery.manualResolve('bet-missing', 'LOST', -700)).rejects.toThrow(CriticalError);
    });
;
    it('throws when bet is not in UNKNOWN state', async () => {
      betRepo.findById.mockResolvedValue({ ...createUnknownBet(), state: 'LOST', pnl: -700 });
      await expect(recovery.manualResolve('bet-1', 'CASHED_OUT', 210)).rejects.toThrow(CriticalError);
    });
  });
;
  describe('configuration', () => {
    it('accepts custom config', () => {
      const custom = new UnknownStateRecovery(betRepo, roundRepo, eventBus, {
        maxBetsPerSweep: 10,
        escalationTimeoutMs: 60000,
      });
      expect(custom).toBeDefined();
    });
;
    it('uses default config when partial overrides provided', () => {
      const custom = new UnknownStateRecovery(betRepo, roundRepo, eventBus, {
        maxBetsPerSweep: 5,
      });
      expect(custom).toBeDefined();
    });
  });
});
;
function createUnknownBet(): any {
  return {
    id: 'bet-1',
    sessionId: 'session-1',
    roundId: 'round-1',
    dailyKey: '2024-01-01',
    stake: 700,
    cashOutTarget: 1.30,
    state: 'UNKNOWN',
    requestedAt: null,
    placedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    cashOutRequestedAt: null,
    cashOutConfirmedAt: null,
    observedCashOutMultiplier: null,
    confirmedCashOutMultiplier: null,
    pnl: null,
    balanceBefore: 5000,
    balanceAfter: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
