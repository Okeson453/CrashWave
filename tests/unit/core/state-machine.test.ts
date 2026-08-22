import { BettingStateMachine, createStateMachine } from '../../../src/core/state-machine/machine';
import { BettingState } from '../../../src/core/state-machine/types';

describe('BettingStateMachine', () => {
  let machine: BettingStateMachine;
  let stateChanges: Array<{ from: BettingState; to: BettingState; event: string }>;

  beforeEach(() => {
    stateChanges = [];
    machine = createStateMachine({
      sessionId: 'test-session',
      onStateChange: (from, to, event) => {
        stateChanges.push({ from, to, event: event.type });
      },
    });
  });

  describe('initialization', () => {
    it('starts in IDLE state', () => {
      expect(machine.getState()).toBe('IDLE');
    });

    it('accepts custom initial state', () => {
      const m = createStateMachine({
        sessionId: 'test',
        initialState: 'OBSERVING',
      });
      expect(m.getState()).toBe('OBSERVING');
    });

    it('has default context values', () => {
      const ctx = machine.getContext();
      expect(ctx.sessionId).toBe('test-session');
      expect(ctx.paused).toBe(false);
      expect(ctx.killSwitch).toBe(false);
      expect(ctx.consecutiveErrors).toBe(0);
      expect(ctx.openBetExists).toBe(false);
    });
  });

  describe('valid transitions', () => {
    it('IDLE → READY_TO_OBSERVE via BROWSER_READY', () => {
      const result = machine.send({ type: 'BROWSER_READY' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('READY_TO_OBSERVE');
    });

    it('READY_TO_OBSERVE → OBSERVING via GAME_LOADED', () => {
      machine.send({ type: 'BROWSER_READY' });
      const result = machine.send({ type: 'GAME_LOADED' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('OBSERVING');
    });

    it('OBSERVING → ENTRY_EVALUATING via ROUND_STARTED (with valid context)', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.updateContext({
        currentBalance: 5000,
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
      });
      const result = machine.send({
        type: 'ROUND_STARTED',
        roundId: 'r1',
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
      });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('ENTRY_EVALUATING');
    });

    it('ENTRY_EVALUATING → ENTRY_APPROVED via RISK_APPROVED', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.updateContext({
        currentBalance: 5000,
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
      });
      machine.send({
        type: 'ROUND_STARTED',
        roundId: 'r1',
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
      });
      const result = machine.send({
        type: 'RISK_APPROVED',
        conditions: {
          modeIsLive: true,
          operatorAuthorized: true,
          sessionAuthenticated: true,
          gameLoaded: true,
          roundStateValid: true,
          balanceSufficient: true,
          dailyEntriesBelowLimit: true,
          notPaused: true,
          killSwitchOff: true,
          browserHealthy: true,
          gameAdapterHealthy: true,
          observationConfidenceHigh: true,
          noOpenBet: true,
          cooldownElapsed: true,
        },
      });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('ENTRY_APPROVED');
    });

    it('ENTRY_APPROVED → BET_PLACING via ENTRY_CHECKS_PASSED', () => {
      setupForBetPlacement(machine);
      const result = machine.send({ type: 'ENTRY_CHECKS_PASSED' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('BET_PLACING');
    });

    it('BET_PLACING → BET_ACTIVE via BET_CONFIRMED', () => {
      setupForBetPlacement(machine);
      machine.send({ type: 'ENTRY_CHECKS_PASSED' });
      const result = machine.send({ type: 'BET_CONFIRMED', betId: 'b1' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('BET_ACTIVE');
      expect(machine.getContext().openBetExists).toBe(true);
      expect(machine.getContext().currentBetId).toBe('b1');
    });

    it('BET_ACTIVE → CASH_OUT_ARMED via MULTIPLIER_REACHED_TARGET', () => {
      setupForActiveBet(machine);
      const result = machine.send({ type: 'MULTIPLIER_REACHED_TARGET', multiplier: 1.30 });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('CASH_OUT_ARMED');
    });

    it('CASH_OUT_ARMED → CASH_OUT_REQUESTED via CASH_OUT_TRIGGERED', () => {
      setupForActiveBet(machine);
      machine.send({ type: 'MULTIPLIER_REACHED_TARGET', multiplier: 1.30 });
      const result = machine.send({ type: 'CASH_OUT_TRIGGERED' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('CASH_OUT_REQUESTED');
    });

    it('CASH_OUT_REQUESTED → ROUND_COMPLETE via CASH_OUT_CONFIRMED', () => {
      setupForActiveBet(machine);
      machine.send({ type: 'MULTIPLIER_REACHED_TARGET', multiplier: 1.30 });
      machine.send({ type: 'CASH_OUT_TRIGGERED' });
      const result = machine.send({ type: 'CASH_OUT_CONFIRMED', multiplier: 1.30, pnl: 210 });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('ROUND_COMPLETE');
      expect(machine.getContext().openBetExists).toBe(false);
    });

    it('BET_ACTIVE → ROUND_COMPLETE via ROUND_CRASHED', () => {
      setupForActiveBet(machine);
      const result = machine.send({ type: 'ROUND_CRASHED', crashPoint: 1.15 });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('ROUND_COMPLETE');
      expect(machine.getContext().openBetExists).toBe(false);
    });

    it('ROUND_COMPLETE → RESULT_RECORDED via OUTCOME_RECORDED', () => {
      setupForCompletedRound(machine);
      const result = machine.send({ type: 'OUTCOME_RECORDED' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('RESULT_RECORDED');
    });

    it('RESULT_RECORDED → COOLDOWN via COOLDOWN_ELAPSED', () => {
      setupForCompletedRound(machine);
      machine.send({ type: 'OUTCOME_RECORDED' });
      const result = machine.send({ type: 'COOLDOWN_ELAPSED' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('COOLDOWN');
    });

    it('COOLDOWN → OBSERVING via COOLDOWN_ELAPSED', () => {
      setupForCompletedRound(machine);
      machine.send({ type: 'OUTCOME_RECORDED' });
      machine.send({ type: 'COOLDOWN_ELAPSED' });
      const result = machine.send({ type: 'COOLDOWN_ELAPSED' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('OBSERVING');
    });

    it('OBSERVING → PAUSED via PAUSE_REQUESTED', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      const result = machine.send({ type: 'PAUSE_REQUESTED', reason: 'operator request' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('PAUSED');
      expect(machine.getContext().paused).toBe(true);
    });

    it('PAUSED → OBSERVING via RESUME_REQUESTED', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.send({ type: 'PAUSE_REQUESTED', reason: 'operator request' });
      const result = machine.send({ type: 'RESUME_REQUESTED' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('OBSERVING');
      expect(machine.getContext().paused).toBe(false);
    });

    it('ERROR → RECONCILING via RECONCILE', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.send({ type: 'STALE_MULTIPLIER' });
      expect(machine.getState()).toBe('ERROR');
      const result = machine.send({ type: 'RECONCILE' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('RECONCILING');
    });

    it('RECONCILING → OBSERVING via RECONCILIATION_COMPLETE', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.send({ type: 'STALE_MULTIPLIER' });
      machine.send({ type: 'RECONCILE' });
      const result = machine.send({ type: 'RECONCILIATION_COMPLETE', resolution: 'LOST' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('OBSERVING');
    });

    it('ERROR → HALTED via HALT', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.send({ type: 'STALE_MULTIPLIER' });
      const result = machine.send({ type: 'HALT', reason: 'emergency stop' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('HALTED');
      expect(machine.getContext().killSwitch).toBe(true);
    });

    it('HALTED → IDLE via RESET', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.send({ type: 'STALE_MULTIPLIER' });
      machine.send({ type: 'HALT', reason: 'emergency stop' });
      const result = machine.send({ type: 'RESET' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('IDLE');
      expect(machine.getContext().consecutiveErrors).toBe(0);
      expect(machine.getContext().openBetExists).toBe(false);
    });
  });

  describe('invalid transitions', () => {
    it('rejects undefined transition from IDLE', () => {
      const result = machine.send({ type: 'ROUND_STARTED', roundId: 'r1', roundState: {
        roundId: 'r1', phase: 'starting', currentMultiplier: 1.0,
        startedAt: new Date().toISOString(), crashedAt: null, crashPoint: null,
        lastTickAt: new Date().toISOString(), source: 'websocket', confidence: 'high'
      }});
      expect(result.accepted).toBe(false);
      expect(machine.getState()).toBe('IDLE');
      expect(result.message).toContain('Invalid transition');
    });

    it('rejects BET_CONFIRMED from OBSERVING', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      const result = machine.send({ type: 'BET_CONFIRMED', betId: 'b1' });
      expect(result.accepted).toBe(false);
      expect(machine.getState()).toBe('OBSERVING');
    });

    it('rejects CASH_OUT_TRIGGERED from BET_PLACING', () => {
      setupForBetPlacement(machine);
      machine.send({ type: 'ENTRY_CHECKS_PASSED' });
      const result = machine.send({ type: 'CASH_OUT_TRIGGERED' });
      expect(result.accepted).toBe(false);
      expect(machine.getState()).toBe('BET_PLACING');
    });

    it('rejects ENTRY_CHECKS_PASSED from IDLE', () => {
      const result = machine.send({ type: 'ENTRY_CHECKS_PASSED' });
      expect(result.accepted).toBe(false);
      expect(machine.getState()).toBe('IDLE');
    });
  });

  describe('failure paths', () => {
    it('BET_PLACING → ERROR on BET_PLACEMENT_TIMEOUT', () => {
      setupForBetPlacement(machine);
      machine.send({ type: 'ENTRY_CHECKS_PASSED' });
      const result = machine.send({ type: 'BET_PLACEMENT_TIMEOUT' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('ERROR');
      expect(machine.getContext().consecutiveErrors).toBe(1);
    });

    it('BET_PLACING → ERROR on BET_PLACEMENT_FAILED', () => {
      setupForBetPlacement(machine);
      machine.send({ type: 'ENTRY_CHECKS_PASSED' });
      const result = machine.send({ type: 'BET_PLACEMENT_FAILED', reason: 'insufficient balance' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('ERROR');
      expect(machine.getContext().consecutiveErrors).toBe(1);
    });

    it('CASH_OUT_REQUESTED → ERROR on CASH_OUT_TIMEOUT', () => {
      setupForActiveBet(machine);
      machine.send({ type: 'MULTIPLIER_REACHED_TARGET', multiplier: 1.30 });
      machine.send({ type: 'CASH_OUT_TRIGGERED' });
      const result = machine.send({ type: 'CASH_OUT_TIMEOUT' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('ERROR');
      expect(machine.getContext().cashOutFailures).toBe(1);
    });

    it('OBSERVING → ERROR on STALE_MULTIPLIER', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      const result = machine.send({ type: 'STALE_MULTIPLIER' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('ERROR');
    });

    it('OBSERVING → ERROR on HEALTH_DEGRADED', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      const result = machine.send({ type: 'HEALTH_DEGRADED', component: 'browser', reason: 'page unresponsive' });
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('ERROR');
    });

    it('ERROR stays in ERROR on CRITICAL_ERROR (no transition defined)', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.send({ type: 'STALE_MULTIPLIER' });
      const result = machine.send({ type: 'CRITICAL_ERROR', error: new Error('browser crashed'), component: 'browser' });
      expect(result.accepted).toBe(false);
      expect(machine.getState()).toBe('ERROR');
      // Rejected transitions do not update context
      expect(machine.getContext().consecutiveErrors).toBe(0);
    });
  });

  describe('guard rejections', () => {
    it('rejects ROUND_STARTED when paused', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.updateContext({
        paused: true,
        currentBalance: 5000,
        roundState: {
          roundId: 'r1', phase: 'starting', currentMultiplier: 1.0,
          startedAt: new Date().toISOString(), crashedAt: null, crashPoint: null,
          lastTickAt: new Date().toISOString(), source: 'websocket', confidence: 'high'
        },
      });
      const result = machine.send({
        type: 'ROUND_STARTED',
        roundId: 'r1',
        roundState: {
          roundId: 'r1', phase: 'starting', currentMultiplier: 1.0,
          startedAt: new Date().toISOString(), crashedAt: null, crashPoint: null,
          lastTickAt: new Date().toISOString(), source: 'websocket', confidence: 'high'
        },
      });
      expect(result.accepted).toBe(false);
      expect(result.message).toContain('paused');
    });

    it('transitions to ERROR when kill switch engaged on ROUND_STARTED', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.updateContext({
        killSwitch: true,
        currentBalance: 5000,
        roundState: {
          roundId: 'r1', phase: 'starting', currentMultiplier: 1.0,
          startedAt: new Date().toISOString(), crashedAt: null, crashPoint: null,
          lastTickAt: new Date().toISOString(), source: 'websocket', confidence: 'high'
        },
      });
      const result = machine.send({
        type: 'ROUND_STARTED',
        roundId: 'r1',
        roundState: {
          roundId: 'r1', phase: 'starting', currentMultiplier: 1.0,
          startedAt: new Date().toISOString(), crashedAt: null, crashPoint: null,
          lastTickAt: new Date().toISOString(), source: 'websocket', confidence: 'high'
        },
      });
      // Kill switch guard failure is treated as error → transitions to ERROR
      expect(result.accepted).toBe(true);
      expect(machine.getState()).toBe('ERROR');
      expect(result.message).toContain('ERROR');
    });

    it('rejects ROUND_STARTED when open bet exists', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.updateContext({
        openBetExists: true,
        currentBalance: 5000,
        roundState: {
          roundId: 'r1', phase: 'starting', currentMultiplier: 1.0,
          startedAt: new Date().toISOString(), crashedAt: null, crashPoint: null,
          lastTickAt: new Date().toISOString(), source: 'websocket', confidence: 'high'
        },
      });
      const result = machine.send({
        type: 'ROUND_STARTED',
        roundId: 'r1',
        roundState: {
          roundId: 'r1', phase: 'starting', currentMultiplier: 1.0,
          startedAt: new Date().toISOString(), crashedAt: null, crashPoint: null,
          lastTickAt: new Date().toISOString(), source: 'websocket', confidence: 'high'
        },
      });
      expect(result.accepted).toBe(false);
      expect(result.message).toContain('open bet');
    });

    it('rejects ROUND_STARTED when browser unhealthy', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.updateContext({
        browserHealthy: false,
        currentBalance: 5000,
        roundState: {
          roundId: 'r1', phase: 'starting', currentMultiplier: 1.0,
          startedAt: new Date().toISOString(), crashedAt: null, crashPoint: null,
          lastTickAt: new Date().toISOString(), source: 'websocket', confidence: 'high'
        },
      });
      const result = machine.send({
        type: 'ROUND_STARTED',
        roundId: 'r1',
        roundState: {
          roundId: 'r1', phase: 'starting', currentMultiplier: 1.0,
          startedAt: new Date().toISOString(), crashedAt: null, crashPoint: null,
          lastTickAt: new Date().toISOString(), source: 'websocket', confidence: 'high'
        },
      });
      expect(result.accepted).toBe(false);
      expect(result.message).toContain('Browser health');
    });
  });

  describe('context updates', () => {
    it('updateContext modifies values without changing state', () => {
      machine.updateContext({ currentBalance: 9999 });
      expect(machine.getContext().currentBalance).toBe(9999);
      expect(machine.getState()).toBe('IDLE');
    });

    it('forceState changes state with recovery source and audit', () => {
      machine.forceState('BET_ACTIVE', 'recovery drill', { source: 'recovery' });
      expect(machine.getState()).toBe('BET_ACTIVE');
    });

    it('forceState rejects empty reason', () => {
      expect(() => machine.forceState('HALTED', '', { source: 'emergency-stop' })).toThrow();
    });
  });

  describe('utility methods', () => {
    it('canAccept returns true for valid events', () => {
      machine.send({ type: 'BROWSER_READY' });
      expect(machine.canAccept('AUTHENTICATED')).toBe(true);
      expect(machine.canAccept('GAME_LOADED')).toBe(true);
    });

    it('canAccept returns false for invalid events', () => {
      expect(machine.canAccept('BET_CONFIRMED')).toBe(false);
    });

    it('isHalted returns true only in HALTED', () => {
      expect(machine.isHalted()).toBe(false);
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      machine.send({ type: 'HALT', reason: 'test' });
      expect(machine.isHalted()).toBe(true);
    });

    it('hasActiveBet returns true during active betting states', () => {
      expect(machine.hasActiveBet()).toBe(false);
      setupForActiveBet(machine);
      expect(machine.hasActiveBet()).toBe(true);
    });
  });

  describe('state change callbacks', () => {
    it('invokes onStateChange for every transition', () => {
      machine.send({ type: 'BROWSER_READY' });
      machine.send({ type: 'GAME_LOADED' });
      expect(stateChanges).toHaveLength(2);
      expect(stateChanges[0]).toEqual({ from: 'IDLE', to: 'READY_TO_OBSERVE', event: 'BROWSER_READY' });
      expect(stateChanges[1]).toEqual({ from: 'READY_TO_OBSERVE', to: 'OBSERVING', event: 'GAME_LOADED' });
    });

    it('invokes onFailure when entering ERROR', () => {
      const failures: Array<{ state: BettingState; reason: string }> = [];
      const m = createStateMachine({
        sessionId: 'test',
        onFailure: (state, reason) => failures.push({ state, reason }),
      });
      m.send({ type: 'BROWSER_READY' });
      m.send({ type: 'GAME_LOADED' });
      m.send({ type: 'STALE_MULTIPLIER' });
      expect(failures).toHaveLength(1);
      expect(failures[0].state).toBe('ERROR');
    });
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setupForBetPlacement(machine: BettingStateMachine): void {
  machine.send({ type: 'BROWSER_READY' });
  machine.send({ type: 'GAME_LOADED' });
  machine.updateContext({
    currentBalance: 5000,
    roundState: {
      roundId: 'r1', phase: 'starting', currentMultiplier: 1.0,
      startedAt: new Date().toISOString(), crashedAt: null, crashPoint: null,
      lastTickAt: new Date().toISOString(), source: 'websocket', confidence: 'high'
    },
  });
  machine.send({
    type: 'ROUND_STARTED',
    roundId: 'r1',
    roundState: {
      roundId: 'r1', phase: 'starting', currentMultiplier: 1.0,
      startedAt: new Date().toISOString(), crashedAt: null, crashPoint: null,
      lastTickAt: new Date().toISOString(), source: 'websocket', confidence: 'high'
    },
  });
  machine.send({
    type: 'RISK_APPROVED',
    conditions: {
      modeIsLive: true, operatorAuthorized: true, sessionAuthenticated: true,
      gameLoaded: true, roundStateValid: true, balanceSufficient: true,
      dailyEntriesBelowLimit: true, notPaused: true, killSwitchOff: true,
      browserHealthy: true, gameAdapterHealthy: true, observationConfidenceHigh: true,
      noOpenBet: true, cooldownElapsed: true,
    },
  });
}

function setupForActiveBet(machine: BettingStateMachine): void {
  setupForBetPlacement(machine);
  machine.send({ type: 'ENTRY_CHECKS_PASSED' });
  machine.send({ type: 'BET_CONFIRMED', betId: 'b1' });
}

function setupForCompletedRound(machine: BettingStateMachine): void {
  setupForActiveBet(machine);
  machine.send({ type: 'MULTIPLIER_REACHED_TARGET', multiplier: 1.30 });
  machine.send({ type: 'CASH_OUT_TRIGGERED' });
  machine.send({ type: 'CASH_OUT_CONFIRMED', multiplier: 1.30, pnl: 210 });
}
