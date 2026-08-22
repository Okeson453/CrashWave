import {
  guardBrowserHealthy,
  guardGameAdapterHealthy,
  guardObservationConfidence,
  guardNotPaused,
  guardKillSwitchOff,
  guardNoOpenBet,
  guardCooldownElapsed,
  guardRoundValid,
  guardBalanceKnown,
  guardErrorThreshold,
  guardCashOutFailureThreshold,
  guardAllEntryConditions,
  guardCanEvaluateEntry,
  guardCanApproveEntry,
  guardCanPlaceBet,
  guardCanCashOut,
  guardCanResume,
  guardCanRecover,
} from '../../../src/core/state-machine/guards';
import { createDefaultContext } from '../../../src/core/state-machine/types';
import { RoundState } from '../../../src/types/game';

describe('State Machine Guards', () => {
  const baseContext = createDefaultContext('test-session');
  const validRound: RoundState = {
    roundId: 'r1',
    phase: 'starting',
    currentMultiplier: 1.0,
    startedAt: new Date().toISOString(),
    crashedAt: null,
    crashPoint: null,
    lastTickAt: new Date().toISOString(),
    source: 'websocket',
    confidence: 'high',
  };

  describe('guardBrowserHealthy', () => {
    it('permits when browser is healthy', () => {
      const result = guardBrowserHealthy({ ...baseContext, browserHealthy: true });
      expect(result.permitted).toBe(true);
    });

    it('rejects when browser is unhealthy', () => {
      const result = guardBrowserHealthy({ ...baseContext, browserHealthy: false });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('Browser health check failed');
    });
  });

  describe('guardGameAdapterHealthy', () => {
    it('permits when adapter is healthy', () => {
      const result = guardGameAdapterHealthy({ ...baseContext, gameAdapterHealthy: true });
      expect(result.permitted).toBe(true);
    });

    it('rejects when adapter is unhealthy', () => {
      const result = guardGameAdapterHealthy({ ...baseContext, gameAdapterHealthy: false });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('Game adapter health check failed');
    });
  });

  describe('guardObservationConfidence', () => {
    it('permits high confidence when high is required', () => {
      const result = guardObservationConfidence(
        { ...baseContext, roundState: { ...validRound, confidence: 'high' } },
        'high'
      );
      expect(result.permitted).toBe(true);
    });

    it('permits high confidence when medium is required', () => {
      const result = guardObservationConfidence(
        { ...baseContext, roundState: { ...validRound, confidence: 'high' } },
        'medium'
      );
      expect(result.permitted).toBe(true);
    });

    it('rejects low confidence when high is required', () => {
      const result = guardObservationConfidence(
        { ...baseContext, roundState: { ...validRound, confidence: 'low' } },
        'high'
      );
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('low');
    });

    it('rejects medium confidence when high is required', () => {
      const result = guardObservationConfidence(
        { ...baseContext, roundState: { ...validRound, confidence: 'medium' } },
        'high'
      );
      expect(result.permitted).toBe(false);
    });

    it('permits medium confidence when medium is required', () => {
      const result = guardObservationConfidence(
        { ...baseContext, roundState: { ...validRound, confidence: 'medium' } },
        'medium'
      );
      expect(result.permitted).toBe(true);
    });

    it('rejects low confidence when medium is required', () => {
      const result = guardObservationConfidence(
        { ...baseContext, roundState: { ...validRound, confidence: 'low' } },
        'medium'
      );
      expect(result.permitted).toBe(false);
    });

    it('uses context minConfidenceForEntry as default', () => {
      const result = guardObservationConfidence(
        { ...baseContext, roundState: { ...validRound, confidence: 'low' } }
      );
      expect(result.permitted).toBe(false);
    });
  });

  describe('guardNotPaused', () => {
    it('permits when not paused', () => {
      const result = guardNotPaused({ ...baseContext, paused: false });
      expect(result.permitted).toBe(true);
    });

    it('rejects when paused', () => {
      const result = guardNotPaused({ ...baseContext, paused: true });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('paused');
    });
  });

  describe('guardKillSwitchOff', () => {
    it('permits when kill switch is off', () => {
      const result = guardKillSwitchOff({ ...baseContext, killSwitch: false });
      expect(result.permitted).toBe(true);
    });

    it('rejects when kill switch is on', () => {
      const result = guardKillSwitchOff({ ...baseContext, killSwitch: true });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('Kill switch');
    });
  });

  describe('guardNoOpenBet', () => {
    it('permits when no open bet', () => {
      const result = guardNoOpenBet({ ...baseContext, openBetExists: false });
      expect(result.permitted).toBe(true);
    });

    it('rejects when open bet exists', () => {
      const result = guardNoOpenBet({ ...baseContext, openBetExists: true });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('open bet');
    });
  });

  describe('guardCooldownElapsed', () => {
    it('permits when no last bet', () => {
      const result = guardCooldownElapsed({ ...baseContext, lastBetAt: null });
      expect(result.permitted).toBe(true);
    });

    it('permits when cooldown has elapsed', () => {
      const result = guardCooldownElapsed({
        ...baseContext,
        lastBetAt: new Date(Date.now() - 10000).toISOString(),
        cooldownMs: 5000,
      });
      expect(result.permitted).toBe(true);
    });

    it('rejects when cooldown is active', () => {
      const result = guardCooldownElapsed({
        ...baseContext,
        lastBetAt: new Date(Date.now() - 1000).toISOString(),
        cooldownMs: 5000,
      });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('Cooldown active');
    });
  });

  describe('guardRoundValid', () => {
    it('permits starting phase', () => {
      const result = guardRoundValid({
        ...baseContext,
        currentRoundId: 'r1',
        roundState: { ...validRound, phase: 'starting' },
      });
      expect(result.permitted).toBe(true);
    });

    it('permits running phase', () => {
      const result = guardRoundValid({
        ...baseContext,
        currentRoundId: 'r1',
        roundState: { ...validRound, phase: 'running' },
      });
      expect(result.permitted).toBe(true);
    });

    it('rejects when no round state', () => {
      const result = guardRoundValid({ ...baseContext, roundState: null });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('No round state');
    });

    it('rejects when no round ID', () => {
      const result = guardRoundValid({
        ...baseContext,
        currentRoundId: null,
        roundState: validRound,
      });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('Round ID is missing');
    });

    it('rejects crashed phase', () => {
      const result = guardRoundValid({
        ...baseContext,
        currentRoundId: 'r1',
        roundState: { ...validRound, phase: 'crashed' },
      });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('crashed');
    });
  });

  describe('guardBalanceKnown', () => {
    it('permits when balance is known', () => {
      const result = guardBalanceKnown({ ...baseContext, currentBalance: 5000 });
      expect(result.permitted).toBe(true);
    });

    it('rejects when balance is null', () => {
      const result = guardBalanceKnown({ ...baseContext, currentBalance: null });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('balance is unknown');
    });

    it('rejects when balance is undefined', () => {
      const result = guardBalanceKnown({ ...baseContext, currentBalance: undefined as unknown as null });
      expect(result.permitted).toBe(false);
    });
  });

  describe('guardErrorThreshold', () => {
    it('permits when below threshold', () => {
      const result = guardErrorThreshold({ ...baseContext, consecutiveErrors: 2, maxConsecutiveErrors: 3 });
      expect(result.permitted).toBe(true);
    });

    it('rejects when at threshold', () => {
      const result = guardErrorThreshold({ ...baseContext, consecutiveErrors: 3, maxConsecutiveErrors: 3 });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('threshold exceeded');
    });

    it('rejects when above threshold', () => {
      const result = guardErrorThreshold({ ...baseContext, consecutiveErrors: 5, maxConsecutiveErrors: 3 });
      expect(result.permitted).toBe(false);
    });
  });

  describe('guardCashOutFailureThreshold', () => {
    it('permits when below threshold', () => {
      const result = guardCashOutFailureThreshold({ ...baseContext, cashOutFailures: 1, maxCashOutFailures: 2 });
      expect(result.permitted).toBe(true);
    });

    it('rejects when at threshold', () => {
      const result = guardCashOutFailureThreshold({ ...baseContext, cashOutFailures: 2, maxCashOutFailures: 2 });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('threshold exceeded');
    });
  });

  describe('guardAllEntryConditions', () => {
    it('permits when all conditions pass', () => {
      const ctx = {
        ...baseContext,
        currentBalance: 5000,
        roundState: validRound,
        currentRoundId: 'r1',
        browserHealthy: true,
        gameAdapterHealthy: true,
        paused: false,
        killSwitch: false,
        openBetExists: false,
        lastBetAt: null,
        consecutiveErrors: 0,
        cashOutFailures: 0,
      };
      const result = guardAllEntryConditions(ctx, { type: 'ROUND_STARTED', roundId: 'r1', roundState: validRound });
      expect(result.permitted).toBe(true);
    });

    it('rejects if any condition fails', () => {
      const ctx = {
        ...baseContext,
        currentBalance: 5000,
        roundState: validRound,
        currentRoundId: 'r1',
        browserHealthy: false,
        gameAdapterHealthy: true,
        paused: false,
        killSwitch: false,
        openBetExists: false,
        lastBetAt: null,
        consecutiveErrors: 0,
        cashOutFailures: 0,
      };
      const result = guardAllEntryConditions(ctx, { type: 'ROUND_STARTED', roundId: 'r1', roundState: validRound });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('Browser health');
    });

    it('reports the first failing condition', () => {
      const ctx = {
        ...baseContext,
        currentBalance: null,
        roundState: validRound,
        currentRoundId: 'r1',
        browserHealthy: true,
        gameAdapterHealthy: true,
        paused: true,
        killSwitch: true,
        openBetExists: true,
        lastBetAt: new Date().toISOString(),
        consecutiveErrors: 0,
        cashOutFailures: 0,
      };
      const result = guardAllEntryConditions(ctx, { type: 'ROUND_STARTED', roundId: 'r1', roundState: validRound });
      expect(result.permitted).toBe(false);
      // Should report the first failure in evaluation order
      expect(result.reason).toBeTruthy();
    });
  });

  describe('guardCanEvaluateEntry', () => {
    it('permits ROUND_STARTED with valid context', () => {
      const ctx = {
        ...baseContext,
        currentBalance: 5000,
        roundState: validRound,
        currentRoundId: 'r1',
        browserHealthy: true,
        gameAdapterHealthy: true,
        paused: false,
        killSwitch: false,
        openBetExists: false,
        lastBetAt: null,
        consecutiveErrors: 0,
        cashOutFailures: 0,
      };
      const result = guardCanEvaluateEntry(ctx, { type: 'ROUND_STARTED', roundId: 'r1', roundState: validRound });
      expect(result.permitted).toBe(true);
    });

    it('rejects non-ROUND_STARTED events', () => {
      const result = guardCanEvaluateEntry(baseContext, { type: 'BET_SUBMITTED', betId: 'b1' });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('ROUND_STARTED');
    });
  });

  describe('guardCanApproveEntry', () => {
    it('permits RISK_APPROVED with valid context', () => {
      const ctx = {
        ...baseContext,
        currentBalance: 5000,
        roundState: validRound,
        currentRoundId: 'r1',
        browserHealthy: true,
        gameAdapterHealthy: true,
        paused: false,
        killSwitch: false,
        openBetExists: false,
        lastBetAt: null,
        consecutiveErrors: 0,
        cashOutFailures: 0,
      };
      const result = guardCanApproveEntry(ctx, {
        type: 'RISK_APPROVED',
        conditions: {
          modeIsLive: true, operatorAuthorized: true, sessionAuthenticated: true,
          gameLoaded: true, roundStateValid: true, balanceSufficient: true,
          dailyEntriesBelowLimit: true, notPaused: true, killSwitchOff: true,
          browserHealthy: true, gameAdapterHealthy: true, observationConfidenceHigh: true,
          noOpenBet: true, cooldownElapsed: true,
        },
      });
      expect(result.permitted).toBe(true);
    });

    it('rejects non-RISK_APPROVED events', () => {
      const result = guardCanApproveEntry(baseContext, { type: 'ENTRY_CHECKS_PASSED' });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('RISK_APPROVED');
    });
  });

  describe('guardCanPlaceBet', () => {
    it('permits ENTRY_CHECKS_PASSED with valid context', () => {
      const ctx = {
        ...baseContext,
        currentBalance: 5000,
        roundState: validRound,
        currentRoundId: 'r1',
        browserHealthy: true,
        gameAdapterHealthy: true,
        paused: false,
        killSwitch: false,
        openBetExists: false,
        lastBetAt: null,
        consecutiveErrors: 0,
        cashOutFailures: 0,
      };
      const result = guardCanPlaceBet(ctx, { type: 'ENTRY_CHECKS_PASSED' });
      expect(result.permitted).toBe(true);
    });

    it('rejects invalid event types', () => {
      const result = guardCanPlaceBet(baseContext, { type: 'ROUND_STARTED', roundId: 'r1', roundState: validRound });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('ENTRY_CHECKS_PASSED');
    });
  });

  describe('guardCanCashOut', () => {
    it('permits when open bet exists and event is valid', () => {
      const ctx = { ...baseContext, openBetExists: true, currentBetId: 'b1' };
      const result = guardCanCashOut(ctx, { type: 'MULTIPLIER_REACHED_TARGET', multiplier: 1.30 });
      expect(result.permitted).toBe(true);
    });

    it('rejects when no open bet', () => {
      const ctx = { ...baseContext, openBetExists: false };
      const result = guardCanCashOut(ctx, { type: 'MULTIPLIER_REACHED_TARGET', multiplier: 1.30 });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('No open bet');
    });

    it('rejects when bet ID is missing', () => {
      const ctx = { ...baseContext, openBetExists: true, currentBetId: null };
      const result = guardCanCashOut(ctx, { type: 'CASH_OUT_TRIGGERED' });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('Bet ID missing');
    });

    it('rejects invalid event types', () => {
      const ctx = { ...baseContext, openBetExists: true, currentBetId: 'b1' };
      const result = guardCanCashOut(ctx, { type: 'ROUND_STARTED', roundId: 'r1', roundState: validRound });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('MULTIPLIER_REACHED_TARGET');
    });
  });

  describe('guardCanResume', () => {
    it('permits when paused', () => {
      const result = guardCanResume({ ...baseContext, paused: true });
      expect(result.permitted).toBe(true);
    });

    it('rejects when not paused', () => {
      const result = guardCanResume({ ...baseContext, paused: false });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('not paused');
    });

    it('rejects when kill switch is engaged', () => {
      const result = guardCanResume({ ...baseContext, paused: true, killSwitch: true });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('kill switch');
    });
  });

  describe('guardCanRecover', () => {
    it('permits when below error threshold', () => {
      const result = guardCanRecover({ ...baseContext, consecutiveErrors: 2, maxConsecutiveErrors: 3 });
      expect(result.permitted).toBe(true);
    });

    it('rejects when at or above error threshold', () => {
      const result = guardCanRecover({ ...baseContext, consecutiveErrors: 3, maxConsecutiveErrors: 3 });
      expect(result.permitted).toBe(false);
      expect(result.reason).toContain('Too many consecutive errors');
    });
  });
});
