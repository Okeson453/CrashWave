import { RoundState, ObservationConfidence } from '../../types/game';
import { EntryConditions } from '../../types/betting';

/**
 * All possible states in the betting state machine.
 * The machine governs the lifecycle of a single betting session,
 * from initialization through observation, entry evaluation, bet placement,
 * cash-out, and completion — with safe failure paths throughout.
 */
export type BettingState =
  | 'IDLE'
  | 'READY_TO_OBSERVE'
  | 'OBSERVING'
  | 'ENTRY_EVALUATING'
  | 'ENTRY_APPROVED'
  | 'BET_PLACING'
  | 'BET_ACTIVE'
  | 'CASH_OUT_ARMED'
  | 'CASH_OUT_REQUESTED'
  | 'ROUND_COMPLETE'
  | 'RESULT_RECORDED'
  | 'COOLDOWN'
  | 'PAUSED'
  | 'ERROR'
  | 'HALTED'
  | 'RECONCILING';

/**
 * Events that can trigger state transitions.
 */
export type StateMachineEvent =
  | { type: 'BROWSER_READY' }
  | { type: 'AUTHENTICATED' }
  | { type: 'GAME_LOADED' }
  | { type: 'ROUND_STARTED'; roundId: string; roundState: RoundState }
  | { type: 'RISK_APPROVED'; conditions: EntryConditions }
  | { type: 'RISK_REJECTED'; reason: string }
  | { type: 'ENTRY_CHECKS_PASSED' }
  | { type: 'ENTRY_CHECKS_FAILED'; reason: string }
  | { type: 'BET_SUBMITTED'; betId: string }
  | { type: 'BET_CONFIRMED'; betId: string }
  | { type: 'BET_PLACEMENT_FAILED'; reason: string }
  | { type: 'BET_PLACEMENT_TIMEOUT' }
  | { type: 'MULTIPLIER_REACHED_TARGET'; multiplier: number }
  | { type: 'CASH_OUT_TRIGGERED' }
  | { type: 'CASH_OUT_CONFIRMED'; multiplier: number; pnl: number }
  | { type: 'CASH_OUT_FAILED'; reason: string }
  | { type: 'CASH_OUT_TIMEOUT' }
  | { type: 'ROUND_CRASHED'; crashPoint: number }
  | { type: 'OUTCOME_RECORDED' }
  | { type: 'COOLDOWN_ELAPSED' }
  | { type: 'PAUSE_REQUESTED'; reason: string }
  | { type: 'RESUME_REQUESTED' }
  | { type: 'RECOVER' }
  | { type: 'RECOVERY_COMPLETE' }
  | { type: 'RECONCILE'; activeBetId?: string }
  | { type: 'RECONCILIATION_COMPLETE'; resolution: 'CASHED_OUT' | 'LOST' | 'UNKNOWN' }
  | { type: 'STALE_MULTIPLIER' }
  | { type: 'HEALTH_DEGRADED'; component: string; reason: string }
  | { type: 'CRITICAL_ERROR'; error: Error; component: string }
  | { type: 'HALT'; reason: string }
  | { type: 'RESET' }
  | { type: 'FORCE_STATE'; reason: string; source: 'recovery' | 'emergency-stop' | 'operator-escalation' };

/**
 * Context maintained by the state machine across transitions.
 * This carries the current operational state needed by guards and actions.
 */
export interface StateMachineContext {
  /** Current session identifier */
  sessionId: string;
  /** Current round identifier (null if no active round) */
  currentRoundId: string | null;
  /** Current bet identifier (null if no active bet) */
  currentBetId: string | null;
  /** Most recent round state observed from the game */
  roundState: RoundState | null;
  /** Current balance as last known */
  currentBalance: number | null;
  /** Whether the system is in dry-run mode (simulated bets) */
  dryRun: boolean;
  /** Whether betting is globally paused */
  paused: boolean;
  /** Whether the kill switch is engaged */
  killSwitch: boolean;
  /** Count of consecutive errors in current session */
  consecutiveErrors: number;
  /** Count of cash-out failures in current session */
  cashOutFailures: number;
  /** Timestamp when the last bet was placed (for cooldown) */
  lastBetAt: string | null;
  /** The evaluated entry conditions from the last risk check */
  lastEntryConditions: EntryConditions | null;
  /** Reason for the most recent rejection or error */
  lastRejectionReason: string | null;
  /** Whether an open bet currently exists */
  openBetExists: boolean;
  /** Health status of browser component */
  browserHealthy: boolean;
  /** Health status of game adapter */
  gameAdapterHealthy: boolean;
  /** Minimum confidence required for entry */
  minConfidenceForEntry: ObservationConfidence;
  /** Cooldown duration in milliseconds */
  cooldownMs: number;
  /** Maximum consecutive errors before halting */
  maxConsecutiveErrors: number;
  /** Maximum cash-out failures before halting */
  maxCashOutFailures: number;
}

/**
 * Default context values for a fresh state machine instance.
 */
export function createDefaultContext(
  sessionId: string,
  overrides?: Partial<StateMachineContext>
): StateMachineContext {
  return {
    sessionId,
    currentRoundId: null,
    currentBetId: null,
    roundState: null,
    currentBalance: null,
    dryRun: false,
    paused: false,
    killSwitch: false,
    consecutiveErrors: 0,
    cashOutFailures: 0,
    lastBetAt: null,
    lastEntryConditions: null,
    lastRejectionReason: null,
    openBetExists: false,
    browserHealthy: true,
    gameAdapterHealthy: true,
    minConfidenceForEntry: 'high',
    cooldownMs: 5000,
    maxConsecutiveErrors: 3,
    maxCashOutFailures: 2,
    ...overrides,
  };
}

/**
 * Result of attempting a state transition.
 */
export interface TransitionResult {
  /** Whether the transition was accepted */
  accepted: boolean;
  /** The new state (same as old if rejected) */
  newState: BettingState;
  /** Human-readable message describing the result */
  message: string;
  /** Updated context after the transition */
  context: StateMachineContext;
}

/**
 * Guard evaluation result.
 */
export interface GuardResult {
  /** Whether the guard permits the transition */
  permitted: boolean;
  /** Reason if the guard rejects */
  reason?: string;
}

/**
 * Configuration for the state machine.
 */
export interface StateMachineConfig {
  /** Session identifier */
  sessionId: string;
  /** Initial state */
  initialState?: BettingState;
  /** Initial context overrides */
  contextOverrides?: Partial<StateMachineContext>;
  /** Callback invoked on every state change */
  onStateChange?: (from: BettingState, to: BettingState, event: StateMachineEvent, context: StateMachineContext) => void;
  /** Callback invoked when the machine enters ERROR or HALTED */
  onFailure?: (state: BettingState, reason: string, context: StateMachineContext) => void;
}
