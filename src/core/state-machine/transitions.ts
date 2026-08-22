import { BettingState, StateMachineEvent } from './types';

/**
 * TransitionRule defines a single allowed transition.
 */
export interface TransitionRule {
  /** The source state */
  from: BettingState;
  /** The event type that triggers this transition */
  event: StateMachineEvent['type'];
  /** The target state */
  to: BettingState;
  /** Whether a guard evaluation is required before this transition */
  requiresGuard: boolean;
  /** Human-readable description of this transition */
  description: string;
}

/**
 * The complete transition matrix for the betting state machine.
 *
 * Every valid state/event combination is listed explicitly.
 * Any combination not listed here is rejected with a clear error.
 *
 * Design principles:
 * - Fail-safe: unknown events → ERROR, critical failures → HALTED
 * - Explicit: every transition is declared, no implicit fallthrough
 * - Guarded: all betting transitions require guard evaluation
 */
export const TRANSITION_RULES: TransitionRule[] = [
  // ─── Initialization ────────────────────────────────────────────────────────
  { from: 'IDLE', event: 'BROWSER_READY', to: 'READY_TO_OBSERVE', requiresGuard: false, description: 'Browser launched and responsive' },
  { from: 'READY_TO_OBSERVE', event: 'AUTHENTICATED', to: 'READY_TO_OBSERVE', requiresGuard: false, description: 'Session authenticated' },
  { from: 'READY_TO_OBSERVE', event: 'GAME_LOADED', to: 'OBSERVING', requiresGuard: false, description: 'Crash game page loaded' },

  // ─── Observation → Entry Evaluation ────────────────────────────────────────
  { from: 'OBSERVING', event: 'ROUND_STARTED', to: 'ENTRY_EVALUATING', requiresGuard: true, description: 'New round started — evaluate entry conditions' },
  { from: 'COOLDOWN', event: 'ROUND_STARTED', to: 'ENTRY_EVALUATING', requiresGuard: true, description: 'New round after cooldown — evaluate entry' },

  // ─── Entry Evaluation Outcomes ─────────────────────────────────────────────
  { from: 'ENTRY_EVALUATING', event: 'RISK_APPROVED', to: 'ENTRY_APPROVED', requiresGuard: true, description: 'Risk engine approved entry — all guards pass' },
  { from: 'ENTRY_EVALUATING', event: 'RISK_REJECTED', to: 'OBSERVING', requiresGuard: false, description: 'Risk engine rejected entry — return to observation' },
  { from: 'ENTRY_EVALUATING', event: 'ENTRY_CHECKS_FAILED', to: 'OBSERVING', requiresGuard: false, description: 'Entry checks failed — return to observation' },

  // ─── Entry Approved → Bet Placement ────────────────────────────────────────
  { from: 'ENTRY_APPROVED', event: 'ENTRY_CHECKS_PASSED', to: 'BET_PLACING', requiresGuard: true, description: 'All entry checks confirmed — place bet' },
  { from: 'ENTRY_APPROVED', event: 'BET_SUBMITTED', to: 'BET_PLACING', requiresGuard: true, description: 'Bet submission initiated' },

  // ─── Bet Placement Outcomes ────────────────────────────────────────────────
  { from: 'BET_PLACING', event: 'BET_CONFIRMED', to: 'BET_ACTIVE', requiresGuard: false, description: 'Bet confirmed by game' },
  { from: 'BET_PLACING', event: 'BET_PLACEMENT_FAILED', to: 'ERROR', requiresGuard: false, description: 'Bet placement failed' },
  { from: 'BET_PLACING', event: 'BET_PLACEMENT_TIMEOUT', to: 'ERROR', requiresGuard: false, description: 'Bet placement timed out' },

  // ─── Bet Active → Cash-Out or Crash ────────────────────────────────────────
  { from: 'BET_ACTIVE', event: 'MULTIPLIER_REACHED_TARGET', to: 'CASH_OUT_ARMED', requiresGuard: false, description: 'Target multiplier reached — arm cash-out' },
  { from: 'BET_ACTIVE', event: 'ROUND_CRASHED', to: 'ROUND_COMPLETE', requiresGuard: false, description: 'Round crashed before cash-out — bet lost' },

  // ─── Cash-Out Armed → Requested ────────────────────────────────────────────
  { from: 'CASH_OUT_ARMED', event: 'CASH_OUT_TRIGGERED', to: 'CASH_OUT_REQUESTED', requiresGuard: true, description: 'Cash-out action triggered' },

  // ─── Cash-Out Requested Outcomes ───────────────────────────────────────────
  { from: 'CASH_OUT_REQUESTED', event: 'CASH_OUT_CONFIRMED', to: 'ROUND_COMPLETE', requiresGuard: false, description: 'Cash-out confirmed — bet won' },
  { from: 'CASH_OUT_REQUESTED', event: 'CASH_OUT_FAILED', to: 'ERROR', requiresGuard: false, description: 'Cash-out failed' },
  { from: 'CASH_OUT_REQUESTED', event: 'CASH_OUT_TIMEOUT', to: 'ERROR', requiresGuard: false, description: 'Cash-out timed out' },
  { from: 'CASH_OUT_REQUESTED', event: 'ROUND_CRASHED', to: 'ROUND_COMPLETE', requiresGuard: false, description: 'Round crashed during cash-out request — bet lost' },

  // ─── Round Complete → Result Recorded ──────────────────────────────────────
  { from: 'ROUND_COMPLETE', event: 'OUTCOME_RECORDED', to: 'RESULT_RECORDED', requiresGuard: false, description: 'Outcome persisted to ledger' },

  // ─── Result Recorded → Cooldown ────────────────────────────────────────────
  { from: 'RESULT_RECORDED', event: 'COOLDOWN_ELAPSED', to: 'COOLDOWN', requiresGuard: false, description: 'Post-round cooldown period' },

  // ─── Cooldown → Observation ────────────────────────────────────────────────
  { from: 'COOLDOWN', event: 'COOLDOWN_ELAPSED', to: 'OBSERVING', requiresGuard: false, description: 'Cooldown complete — resume observation' },

  // ─── Pause / Resume ────────────────────────────────────────────────────────
  { from: 'OBSERVING', event: 'PAUSE_REQUESTED', to: 'PAUSED', requiresGuard: false, description: 'Operator requested pause' },
  { from: 'ENTRY_EVALUATING', event: 'PAUSE_REQUESTED', to: 'PAUSED', requiresGuard: false, description: 'Operator paused during evaluation' },
  { from: 'ENTRY_APPROVED', event: 'PAUSE_REQUESTED', to: 'PAUSED', requiresGuard: false, description: 'Operator paused after approval' },
  { from: 'COOLDOWN', event: 'PAUSE_REQUESTED', to: 'PAUSED', requiresGuard: false, description: 'Operator paused during cooldown' },
  { from: 'PAUSED', event: 'RESUME_REQUESTED', to: 'OBSERVING', requiresGuard: true, description: 'Operator requested resume' },

  // ─── Error Handling ────────────────────────────────────────────────────────
  { from: 'OBSERVING', event: 'STALE_MULTIPLIER', to: 'ERROR', requiresGuard: false, description: 'Multiplier data stale' },
  { from: 'OBSERVING', event: 'HEALTH_DEGRADED', to: 'ERROR', requiresGuard: false, description: 'Health degraded during observation' },
  { from: 'ENTRY_EVALUATING', event: 'HEALTH_DEGRADED', to: 'ERROR', requiresGuard: false, description: 'Health degraded during evaluation' },
  { from: 'BET_PLACING', event: 'HEALTH_DEGRADED', to: 'ERROR', requiresGuard: false, description: 'Health degraded during bet placement' },
  { from: 'BET_ACTIVE', event: 'HEALTH_DEGRADED', to: 'ERROR', requiresGuard: false, description: 'Health degraded while bet active' },
  { from: 'CASH_OUT_REQUESTED', event: 'HEALTH_DEGRADED', to: 'ERROR', requiresGuard: false, description: 'Health degraded during cash-out' },

  { from: 'BET_ACTIVE', event: 'CRITICAL_ERROR', to: 'ERROR', requiresGuard: false, description: 'Critical error while bet active' },
  { from: 'BET_PLACING', event: 'CRITICAL_ERROR', to: 'ERROR', requiresGuard: false, description: 'Critical error during bet placement' },
  { from: 'CASH_OUT_REQUESTED', event: 'CRITICAL_ERROR', to: 'ERROR', requiresGuard: false, description: 'Critical error during cash-out' },
  { from: 'OBSERVING', event: 'CRITICAL_ERROR', to: 'ERROR', requiresGuard: false, description: 'Critical error during observation' },

  // ─── Recovery ──────────────────────────────────────────────────────────────

  // ─── Disconnect / Socket Drop → RECONCILING ────────────────────────────────
  { from: 'OBSERVING', event: 'RECONCILE', to: 'RECONCILING', requiresGuard: false, description: 'Socket drop — enter reconciliation' },
  { from: 'ENTRY_EVALUATING', event: 'RECONCILE', to: 'RECONCILING', requiresGuard: false, description: 'Socket drop during evaluation' },
  { from: 'BET_PLACING', event: 'RECONCILE', to: 'RECONCILING', requiresGuard: false, description: 'Socket drop during bet placement' },
  { from: 'BET_ACTIVE', event: 'RECONCILE', to: 'RECONCILING', requiresGuard: false, description: 'Socket drop while bet active' },
  { from: 'CASH_OUT_ARMED', event: 'RECONCILE', to: 'RECONCILING', requiresGuard: false, description: 'Socket drop while cash-out armed' },
  { from: 'CASH_OUT_REQUESTED', event: 'RECONCILE', to: 'RECONCILING', requiresGuard: false, description: 'Socket drop during cash-out' },
  { from: 'COOLDOWN', event: 'RECONCILE', to: 'RECONCILING', requiresGuard: false, description: 'Socket drop during cooldown' },

  { from: 'ERROR', event: 'RECOVER', to: 'RECONCILING', requiresGuard: true, description: 'Attempt recovery from error' },
  { from: 'ERROR', event: 'RECONCILE', to: 'RECONCILING', requiresGuard: false, description: 'Enter reconciliation mode' },
  // After reconciliation always resume observation (browser already live). IDLE requires full re-init.
  { from: 'RECONCILING', event: 'RECONCILIATION_COMPLETE', to: 'OBSERVING', requiresGuard: false, description: 'Reconciliation finished — resume observation' },
  { from: 'RECONCILING', event: 'RECOVERY_COMPLETE', to: 'OBSERVING', requiresGuard: false, description: 'Recovery complete — resume observation' },

  // ─── Halt ──────────────────────────────────────────────────────────────────
  { from: 'ERROR', event: 'HALT', to: 'HALTED', requiresGuard: false, description: 'Halt from error state' },
  { from: 'OBSERVING', event: 'HALT', to: 'HALTED', requiresGuard: false, description: 'Emergency halt from observation' },
  { from: 'PAUSED', event: 'HALT', to: 'HALTED', requiresGuard: false, description: 'Emergency halt from paused' },
  { from: 'RECONCILING', event: 'HALT', to: 'HALTED', requiresGuard: false, description: 'Halt during reconciliation' },
  { from: 'BET_ACTIVE', event: 'HALT', to: 'HALTED', requiresGuard: false, description: 'Emergency halt with active bet' },

  // ─── Reset ─────────────────────────────────────────────────────────────────
  { from: 'HALTED', event: 'RESET', to: 'IDLE', requiresGuard: false, description: 'Reset from halted to idle' },
  { from: 'ERROR', event: 'RESET', to: 'IDLE', requiresGuard: false, description: 'Reset from error to idle' },
  { from: 'PAUSED', event: 'RESET', to: 'IDLE', requiresGuard: false, description: 'Reset from paused to idle' },
];

/**
 * Build a lookup map for fast transition resolution.
 * Key format: `${fromState}:${eventType}`
 */
const transitionMap = new Map<string, TransitionRule[]>();

for (const rule of TRANSITION_RULES) {
  const key = `${rule.from}:${rule.event}`;
  const existing = transitionMap.get(key) ?? [];
  existing.push(rule);
  transitionMap.set(key, existing);
}

/**
 * Find all transition rules for a given (state, event) pair.
 */
export function findTransitions(
  from: BettingState,
  eventType: StateMachineEvent['type']
): TransitionRule[] {
  return transitionMap.get(`${from}:${eventType}`) ?? [];
}

/**
 * Check if a transition is defined (regardless of guard outcome).
 */
export function isTransitionDefined(
  from: BettingState,
  eventType: StateMachineEvent['type']
): boolean {
  return transitionMap.has(`${from}:${eventType}`);
}

/**
 * Get all valid event types for a given state.
 */
export function getValidEventsForState(from: BettingState): StateMachineEvent['type'][] {
  const events = new Set<StateMachineEvent['type']>();
  for (const rule of TRANSITION_RULES) {
    if (rule.from === from) {
      events.add(rule.event);
    }
  }
  return Array.from(events);
}

/**
 * Get all reachable states from a given state.
 */
export function getReachableStates(from: BettingState): BettingState[] {
  const states = new Set<BettingState>();
  for (const rule of TRANSITION_RULES) {
    if (rule.from === from) {
      states.add(rule.to);
    }
  }
  return Array.from(states);
}
