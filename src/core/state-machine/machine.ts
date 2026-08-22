import {
  BettingState,
  StateMachineEvent,
  StateMachineContext,
  StateMachineConfig,
  TransitionResult,
  createDefaultContext,
} from './types';
import { findTransitions, isTransitionDefined } from './transitions';
import {
  guardCanEvaluateEntry,
  guardCanApproveEntry,
  guardCanPlaceBet,
  guardCanCashOut,
  guardCanResume,
  guardCanRecover,
} from './guards';

/**
 * BettingStateMachine governs the lifecycle of a single betting session.
 *
 * Every state transition is explicit, guarded, and logged.
 * The machine is fail-safe: unknown events are rejected, guard failures
 * either reject or transition to ERROR depending on severity.
 */
export class BettingStateMachine {
  private state: BettingState;
  private context: StateMachineContext;
  private onStateChange?: (
    from: BettingState,
    to: BettingState,
    event: StateMachineEvent,
    context: StateMachineContext
  ) => void;
  private onFailure?: (
    state: BettingState,
    reason: string,
    context: StateMachineContext
  ) => void;

  constructor(config: StateMachineConfig) {
    this.state = config.initialState ?? 'IDLE';
    this.context = createDefaultContext(config.sessionId, config.contextOverrides);
    this.onStateChange = config.onStateChange;
    this.onFailure = config.onFailure;
  }

  getState(): BettingState {
    return this.state;
  }

  getContext(): StateMachineContext {
    return this.context;
  }

  updateContext(overrides: Partial<StateMachineContext>): void {
    this.context = { ...this.context, ...overrides };
  }

  /**
   * Restricted forced transition for recovery / emergency-stop only (P1.4).
   * Emits a critical audit callback via onFailure so every force is observable.
   */
  forceState(
    state: BettingState,
    reason: string,
    context: { source: 'recovery' | 'emergency-stop' | 'operator-escalation'; operatorId?: string } = {
      source: 'recovery',
    }
  ): void {
    const from = this.state;
    if (!reason || reason.trim().length === 0) {
      throw new Error('forceState requires a non-empty reason');
    }
    if (!['recovery', 'emergency-stop', 'operator-escalation'].includes(context.source)) {
      throw new Error(`forceState denied: invalid source ${context.source}`);
    }
    this.state = state;
    this.notifyFailure(
      state,
      `FORCED_TRANSITION source=${context.source} from=${from} to=${state} reason=${reason} operator=${context.operatorId ?? 'system'}`
    );
    this.notifyStateChange(from, state, {
      type: 'FORCE_STATE',
      reason,
      source: context.source,
    });
  }

  canAccept(eventType: string): boolean {
    return isTransitionDefined(this.state, eventType as StateMachineEvent['type']);
  }

  isHalted(): boolean {
    return this.state === 'HALTED';
  }

  hasActiveBet(): boolean {
    return (
      this.state === 'BET_PLACING' ||
      this.state === 'BET_ACTIVE' ||
      this.state === 'CASH_OUT_ARMED' ||
      this.state === 'CASH_OUT_REQUESTED'
    );
  }

  send(event: StateMachineEvent): TransitionResult {
    // Pre-populate context from event before guard evaluation so guards
    // have access to event-derived state (e.g., roundState from ROUND_STARTED)
    this.preloadContextFromEvent(event);

    const transitions = findTransitions(this.state, event.type);

    if (transitions.length === 0) {
      const message = `Invalid transition: ${this.state} → ? via ${event.type}`;
      return {
        accepted: false,
        newState: this.state,
        message,
        context: this.context,
      };
    }

    // Use the first matching transition rule
    const rule = transitions[0];

    // Evaluate guard if required
    if (rule.requiresGuard) {
      const guardResult = this.evaluateGuard(event);
      if (!guardResult.permitted) {
        // For certain states, guard failure transitions to ERROR instead of just rejecting
        if (this.shouldTransitionToErrorOnGuardFailure(event)) {
          const from = this.state;
          this.state = 'ERROR';
          this.context.consecutiveErrors++;
          const message = `Guard rejected: ${guardResult.reason} — transitioned to ERROR`;
          this.notifyStateChange(from, 'ERROR', event);
          this.notifyFailure('ERROR', guardResult.reason ?? 'Guard rejected');
          return {
            accepted: true,
            newState: 'ERROR',
            message,
            context: this.context,
          };
        }

        return {
          accepted: false,
          newState: this.state,
          message: guardResult.reason ?? 'Guard rejected transition',
          context: this.context,
        };
      }
    }

    const from = this.state;
    const to = rule.to;
    this.state = to;

    // Apply side effects based on the transition
    this.applySideEffects(event, from, to);

    // Notify callbacks
    this.notifyStateChange(from, to, event);

    if (to === 'ERROR' || to === 'HALTED') {
      const reason = this.extractFailureReason(event, to);
      this.notifyFailure(to, reason);
    }

    return {
      accepted: true,
      newState: to,
      message: rule.description,
      context: this.context,
    };
  }

  private preloadContextFromEvent(event: StateMachineEvent): void {
    if (event.type === 'ROUND_STARTED') {
      this.context.currentRoundId = event.roundId;
      this.context.roundState = event.roundState;
    }
  }

  private evaluateGuard(event: StateMachineEvent): { permitted: boolean; reason?: string } {
    switch (this.state) {
      case 'OBSERVING':
      case 'COOLDOWN':
        if (event.type === 'ROUND_STARTED') {
          return guardCanEvaluateEntry(this.context, event);
        }
        if (event.type === 'RESUME_REQUESTED') {
          return guardCanResume(this.context);
        }
        break;
      case 'ENTRY_EVALUATING':
        if (event.type === 'RISK_APPROVED') {
          return guardCanApproveEntry(this.context, event);
        }
        break;
      case 'ENTRY_APPROVED':
        if (event.type === 'ENTRY_CHECKS_PASSED' || event.type === 'BET_SUBMITTED') {
          return guardCanPlaceBet(this.context, event);
        }
        break;
      case 'CASH_OUT_ARMED':
        if (event.type === 'CASH_OUT_TRIGGERED') {
          return guardCanCashOut(this.context, event);
        }
        break;
      case 'PAUSED':
        if (event.type === 'RESUME_REQUESTED') {
          return guardCanResume(this.context);
        }
        break;
      case 'ERROR':
        if (event.type === 'RECOVER') {
          return guardCanRecover(this.context);
        }
        break;
    }
    return { permitted: true };
  }

  private shouldTransitionToErrorOnGuardFailure(event: StateMachineEvent): boolean {
    // Guard failures during entry evaluation from OBSERVING/COOLDOWN with killSwitch
    // or other critical conditions should transition to ERROR
    if (
      (this.state === 'OBSERVING' || this.state === 'COOLDOWN') &&
      event.type === 'ROUND_STARTED'
    ) {
      return this.context.killSwitch;
    }
    return false;
  }

  private applySideEffects(event: StateMachineEvent, _from: BettingState, to: BettingState): void {
    // Pause / Resume
    if (event.type === 'PAUSE_REQUESTED') {
      this.context.paused = true;
    }
    if (event.type === 'RESUME_REQUESTED') {
      this.context.paused = false;
    }

    // Round tracking
    if (event.type === 'ROUND_STARTED') {
      this.context.currentRoundId = event.roundId;
      this.context.roundState = event.roundState;
    }

    // Bet tracking
    if (event.type === 'BET_CONFIRMED') {
      this.context.openBetExists = true;
      this.context.currentBetId = event.betId;
      this.context.consecutiveErrors = 0;
    }

    if (event.type === 'BET_SUBMITTED') {
      this.context.currentBetId = event.betId;
    }

    // Cash-out tracking
    if (event.type === 'CASH_OUT_CONFIRMED') {
      this.context.openBetExists = false;
      this.context.currentBetId = null;
      this.context.cashOutFailures = 0;
    }

    // Round crash / completion
    if (event.type === 'ROUND_CRASHED') {
      this.context.openBetExists = false;
      this.context.currentBetId = null;
    }

    // Error tracking
    if (to === 'ERROR') {
      if (event.type === 'BET_PLACEMENT_FAILED' || event.type === 'BET_PLACEMENT_TIMEOUT') {
        this.context.consecutiveErrors++;
      }
      if (event.type === 'CASH_OUT_FAILED' || event.type === 'CASH_OUT_TIMEOUT') {
        this.context.cashOutFailures++;
      }
      if (event.type === 'STALE_MULTIPLIER' || event.type === 'HEALTH_DEGRADED') {
        // These don't increment consecutiveErrors per test expectations
      }
    }

    // Halt
    if (event.type === 'HALT') {
      this.context.killSwitch = true;
    }

    // Reset
    if (event.type === 'RESET') {
      this.context.consecutiveErrors = 0;
      this.context.cashOutFailures = 0;
      this.context.openBetExists = false;
      this.context.currentBetId = null;
      this.context.paused = false;
      this.context.killSwitch = false;
    }

    // Recovery
    if (event.type === 'RECONCILIATION_COMPLETE') {
      this.context.openBetExists = false;
      this.context.currentBetId = null;
    }

    // Cooldown timestamp
    if (to === 'RESULT_RECORDED') {
      this.context.lastBetAt = new Date().toISOString();
    }
  }

  private extractFailureReason(event: StateMachineEvent, state: BettingState): string {
    if (state === 'HALTED') {
      if (event.type === 'HALT') {
        return (event as Extract<StateMachineEvent, { type: 'HALT' }>).reason;
      }
      return 'System halted';
    }
    if (event.type === 'BET_PLACEMENT_FAILED') {
      return (event as Extract<StateMachineEvent, { type: 'BET_PLACEMENT_FAILED' }>).reason;
    }
    if (event.type === 'HEALTH_DEGRADED') {
      return `${(event as Extract<StateMachineEvent, { type: 'HEALTH_DEGRADED' }>).component}: ${(event as Extract<StateMachineEvent, { type: 'HEALTH_DEGRADED' }>).reason}`;
    }
    if (event.type === 'STALE_MULTIPLIER') {
      return 'Multiplier data stale';
    }
    return 'Unknown error';
  }

  private notifyStateChange(from: BettingState, to: BettingState, event: StateMachineEvent): void {
    if (this.onStateChange) {
      try {
        this.onStateChange(from, to, event, this.context);
      } catch {
        // Callback errors must not break the state machine
      }
    }
  }

  private notifyFailure(state: BettingState, reason: string): void {
    if (this.onFailure) {
      try {
        this.onFailure(state, reason, this.context);
      } catch {
        // Callback errors must not break the state machine
      }
    }
  }
}

/**
 * Factory function to create a new BettingStateMachine instance.
 */
export function createStateMachine(config: StateMachineConfig): BettingStateMachine {
  return new BettingStateMachine(config);
}
