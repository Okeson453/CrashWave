import { RiskEngine } from '../../../src/betting/risk-engine';
import { RiskEvaluationInput } from '../../../src/betting/types';

describe('RiskEngine', () => {
  let engine: RiskEngine;

  const validInput: RiskEvaluationInput = {
    mode: 'live',
    operatorAuthorized: true,
    sessionAuthenticated: true,
    gameLoaded: true,
    roundState: {
      roundId: 'r1',
      phase: 'starting',
      currentMultiplier: 1.0,
      startedAt: new Date().toISOString(),
      crashedAt: null,
      crashPoint: null,
      lastTickAt: new Date().toISOString(),
      source: 'websocket',
      confidence: 'high',
    },
    currentBalance: 5000,
    dailyEntriesConfirmed: 0,
    paused: false,
    killSwitch: false,
    browserHealthy: true,
    gameAdapterHealthy: true,
    openBetExists: false,
    cooldownElapsed: true,
    requiredStake: 700,
    balanceBuffer: 500,
    maxDailyEntries: 100,
    minConfidenceForEntry: 'high',
    consecutiveErrors: 0,
    maxConsecutiveErrors: 3,
    cashOutFailures: 0,
    maxCashOutFailures: 2,
  };

  beforeEach(() => {
    engine = new RiskEngine();
  });

  describe('approve', () => {
    it('approves when all conditions pass', () => {
      const result = engine.evaluate(validInput);
      expect(result.approved).toBe(true);
      expect(result.rejectionReason).toBeNull();
      expect(result.firstFailure).toBeNull();
    });

    it('approves in dry-run mode', () => {
      const result = engine.evaluate({ ...validInput, mode: 'dry-run' });
      expect(result.approved).toBe(true);
    });
  });

  describe('mode checks', () => {
    it('rejects observe-only mode', () => {
      const result = engine.evaluate({ ...validInput, mode: 'observe-only' });
      expect(result.approved).toBe(false);
      expect(result.firstFailure).toContain('mode');
    });

    it('rejects maintenance mode', () => {
      const result = engine.evaluate({ ...validInput, mode: 'maintenance' });
      expect(result.approved).toBe(false);
      expect(result.conditions.modeIsLive).toBe(false);
    });
  });

  describe('authorization checks', () => {
    it('rejects unauthorized operator', () => {
      const result = engine.evaluate({ ...validInput, operatorAuthorized: false });
      expect(result.approved).toBe(false);
      expect(result.conditions.operatorAuthorized).toBe(false);
    });

    it('rejects unauthenticated session', () => {
      const result = engine.evaluate({ ...validInput, sessionAuthenticated: false });
      expect(result.approved).toBe(false);
      expect(result.conditions.sessionAuthenticated).toBe(false);
    });
  });

  describe('game state checks', () => {
    it('rejects when game not loaded', () => {
      const result = engine.evaluate({ ...validInput, gameLoaded: false });
      expect(result.approved).toBe(false);
      expect(result.conditions.gameLoaded).toBe(false);
    });

    it('rejects invalid round state (null)', () => {
      const result = engine.evaluate({ ...validInput, roundState: null });
      expect(result.approved).toBe(false);
      expect(result.conditions.roundStateValid).toBe(false);
    });

    it('rejects crashed round phase', () => {
      const result = engine.evaluate({
        ...validInput,
        roundState: {
          ...validInput.roundState!,
          phase: 'crashed',
          crashPoint: 1.5,
          crashedAt: new Date().toISOString(),
        },
      });
      expect(result.approved).toBe(false);
      expect(result.conditions.roundStateValid).toBe(false);
    });

    it('rejects unknown round phase', () => {
      const result = engine.evaluate({
        ...validInput,
        roundState: {
          ...validInput.roundState!,
          phase: 'unknown' as any,
        },
      });
      expect(result.approved).toBe(false);
    });
  });

  describe('balance checks', () => {
    it('rejects insufficient balance', () => {
      const result = engine.evaluate({ ...validInput, currentBalance: 1000 });
      expect(result.approved).toBe(false);
      expect(result.conditions.balanceSufficient).toBe(false);
    });

    it('rejects unknown balance (null)', () => {
      const result = engine.evaluate({ ...validInput, currentBalance: null });
      expect(result.approved).toBe(false);
      expect(result.conditions.balanceSufficient).toBe(false);
    });

    it('approves with exactly enough balance', () => {
      const result = engine.evaluate({ ...validInput, currentBalance: 1200 });
      expect(result.approved).toBe(true);
      expect(result.conditions.balanceSufficient).toBe(true);
    });
  });

  describe('daily limit checks', () => {
    it('rejects when daily limit reached', () => {
      const result = engine.evaluate({ ...validInput, dailyEntriesConfirmed: 100 });
      expect(result.approved).toBe(false);
      expect(result.conditions.dailyEntriesBelowLimit).toBe(false);
    });

    it('approves at limit - 1', () => {
      const result = engine.evaluate({ ...validInput, dailyEntriesConfirmed: 99 });
      expect(result.approved).toBe(true);
      expect(result.conditions.dailyEntriesBelowLimit).toBe(true);
    });
  });

  describe('operational checks', () => {
    it('rejects when paused', () => {
      const result = engine.evaluate({ ...validInput, paused: true });
      expect(result.approved).toBe(false);
      expect(result.conditions.notPaused).toBe(false);
    });

    it('rejects when kill switch engaged', () => {
      const result = engine.evaluate({ ...validInput, killSwitch: true });
      expect(result.approved).toBe(false);
      expect(result.conditions.killSwitchOff).toBe(false);
    });
  });

  describe('health checks', () => {
    it('rejects unhealthy browser', () => {
      const result = engine.evaluate({ ...validInput, browserHealthy: false });
      expect(result.approved).toBe(false);
      expect(result.conditions.browserHealthy).toBe(false);
    });

    it('rejects unhealthy game adapter', () => {
      const result = engine.evaluate({ ...validInput, gameAdapterHealthy: false });
      expect(result.approved).toBe(false);
      expect(result.conditions.gameAdapterHealthy).toBe(false);
    });
  });

  describe('confidence checks', () => {
    it('rejects low confidence', () => {
      const result = engine.evaluate({
        ...validInput,
        roundState: { ...validInput.roundState!, confidence: 'low' },
      });
      expect(result.approved).toBe(false);
      expect(result.conditions.observationConfidenceHigh).toBe(false);
    });

    it('rejects medium confidence', () => {
      const result = engine.evaluate({
        ...validInput,
        roundState: { ...validInput.roundState!, confidence: 'medium' },
      });
      expect(result.approved).toBe(false);
      expect(result.conditions.observationConfidenceHigh).toBe(false);
    });
  });

  describe('bet state checks', () => {
    it('rejects when open bet exists', () => {
      const result = engine.evaluate({ ...validInput, openBetExists: true });
      expect(result.approved).toBe(false);
      expect(result.conditions.noOpenBet).toBe(false);
    });

    it('rejects when cooldown not elapsed', () => {
      const result = engine.evaluate({ ...validInput, cooldownElapsed: false });
      expect(result.approved).toBe(false);
      expect(result.conditions.cooldownElapsed).toBe(false);
    });
  });

  describe('error threshold checks', () => {
    it('rejects when consecutive errors at threshold', () => {
      const result = engine.evaluate({ ...validInput, consecutiveErrors: 3 });
      expect(result.approved).toBe(false);
      expect(result.conditions.errorThresholdOk).toBe(false);
    });

    it('rejects when cash-out failures at threshold', () => {
      const result = engine.evaluate({ ...validInput, cashOutFailures: 2 });
      expect(result.approved).toBe(false);
      expect(result.conditions.cashOutFailureThresholdOk).toBe(false);
    });
  });

  describe('multiple failures', () => {
    it('reports all failures in rejection reason', () => {
      const result = engine.evaluate({
        ...validInput,
        mode: 'observe-only',
        paused: true,
        killSwitch: true,
        browserHealthy: false,
      });
      expect(result.approved).toBe(false);
      expect(result.firstFailure).toBeTruthy();
      expect(result.rejectionReason).toContain('failures');
    });
  });

  describe('isApproved shorthand', () => {
    it('returns true for approved input', () => {
      expect(engine.isApproved(validInput)).toBe(true);
    });

    it('returns false for rejected input', () => {
      expect(engine.isApproved({ ...validInput, paused: true })).toBe(false);
    });
  });
});
