import { BetState, BetPlacementResult, CashOutResult } from '../types/betting';
export { BetState, BetPlacementResult, CashOutResult };
import { RoundState } from '../types/game';

/**
 * Betting module type definitions.
 *
 * These extend the base types from src/types/betting.ts with
 * execution-specific types for the betting engine, cash-out controller,
 * risk engine, and idempotency layer.
 */

// ─── Bet Executor Types ──────────────────────────────────────────────────────

/**
 * Configuration for the bet executor.
 */
export interface BetExecutorConfig {
  /** Fixed stake per entry (default: 700) */
  stake: number;
  /** Fixed cash-out target multiplier (default: 1.30) */
  target: number;
  /** Maximum time to wait for bet placement confirmation */
  placementTimeoutMs: number;
  /** Maximum time to wait for cash-out confirmation */
  cashOutTimeoutMs: number;
  /** Maximum retries for bet placement */
  maxPlacementRetries: number;
  /** Delay between placement retries */
  placementRetryDelayMs: number;
  /** Whether to use native auto cash-out if available */
  useNativeAutoCashOut: boolean;
}

/**
 * Request to place a bet on a specific round.
 */
export interface PlaceBetRequest {
  /** Unique bet identifier */
  betId: string;
  /** Round identifier */
  roundId: string;
  /** Session identifier */
  sessionId: string;
  /** Stake amount */
  stake: number;
  /** Target cash-out multiplier */
  target: number;
  /** Idempotency key for this bet */
  idempotencyKey: string;
  /** Whether this is a dry-run (simulated) bet */
  dryRun: boolean;
}

/**
 * Detailed result of a bet placement attempt.
 */
export interface BetExecutionResult {
  /** Whether the bet was successfully placed */
  placed: boolean;
  /** Current bet state after the attempt */
  state: BetState;
  /** Error message if placement failed */
  error?: string;
  /** Timestamp when placement was attempted */
  attemptedAt: string;
  /** Timestamp when confirmation was received (null if not confirmed) */
  confirmedAt: string | null;
  /** Number of retry attempts made */
  retryCount: number;
}

/**
 * Interface for the physical bet placement adapter.
 * This abstracts the actual browser interaction (Playwright clicks/API calls).
 */
export interface BetPlacementAdapter {
  /**
   * Submit a bet to the game.
   * Returns true if the submission was accepted by the UI/API.
   * This does NOT mean the bet is confirmed — confirmation is observed separately.
   */
  submitBet(request: PlaceBetRequest): Promise<boolean>;

  /**
   * Wait for bet confirmation from the game.
   * Returns the confirmed bet details or null if confirmation timed out.
   */
  waitForConfirmation(betId: string, timeoutMs: number): Promise<boolean>;

  /**
   * Request cash-out for an active bet.
   */
  requestCashOut(betId: string, roundId: string): Promise<boolean>;

  /**
   * Wait for cash-out confirmation.
   */
  waitForCashOutConfirmation(betId: string, timeoutMs: number): Promise<CashOutResult>;

  /**
   * Set native auto cash-out target if supported by the game.
   */
  setNativeAutoCashOut?(target: number): Promise<boolean>;
}

// ─── Cash-Out Controller Types ───────────────────────────────────────────────

/**
 * Configuration for the cash-out controller.
 */
export interface CashOutConfig {
  /** Target multiplier to cash out at */
  targetMultiplier: number;
  /** Latency buffer — trigger slightly before target to account for execution delay */
  latencyBufferMs: number;
  /** Maximum time to wait for cash-out confirmation */
  confirmationTimeoutMs: number;
  /** Whether to use the game's native auto cash-out feature */
  preferNativeAutoCashOut: boolean;
}

/**
 * State of the cash-out controller for a single bet.
 */
export interface CashOutControllerState {
  /** Bet identifier */
  betId: string;
  /** Round identifier */
  roundId: string;
  /** Whether cash-out has been triggered */
  triggered: boolean;
  /** Whether cash-out has been confirmed */
  confirmed: boolean;
  /** The multiplier at which cash-out was triggered */
  triggeredAtMultiplier: number | null;
  /** The multiplier at which cash-out was confirmed */
  confirmedAtMultiplier: number | null;
  /** P&L from the cash-out */
  pnl: number | null;
  /** Error if cash-out failed */
  error: string | null;
  /** Timestamp when cash-out was triggered */
  triggeredAt: string | null;
  /** Timestamp when cash-out was confirmed */
  confirmedAt: string | null;
}

/**
 * Result of monitoring a multiplier stream for cash-out.
 */
export interface CashOutMonitorResult {
  /** Whether cash-out was successful */
  success: boolean;
  /** Final state of the bet */
  finalState: BetState;
  /** Realized P&L (null if bet lost or failed) */
  pnl: number | null;
  /** The multiplier at which cash-out occurred (null if not cashed out) */
  cashOutMultiplier: number | null;
  /** Error message if cash-out failed */
  error?: string;
}

// ─── Risk Engine Types ───────────────────────────────────────────────────────

/**
 * Input for risk engine evaluation.
 */
export interface RiskEvaluationInput {
  /** Current system mode */
  mode: 'observe-only' | 'dry-run' | 'live' | 'maintenance';
  /** Whether the operator is authorized */
  operatorAuthorized: boolean;
  /** Whether the session is authenticated */
  sessionAuthenticated: boolean;
  /** Whether the game is loaded */
  gameLoaded: boolean;
  /** Current round state */
  roundState: RoundState | null;
  /** Current balance */
  currentBalance: number | null;
  /** Number of confirmed entries today */
  dailyEntriesConfirmed: number;
  /** Whether the system is paused */
  paused: boolean;
  /** Whether the kill switch is engaged */
  killSwitch: boolean;
  /** Browser health status */
  browserHealthy: boolean;
  /** Game adapter health status */
  gameAdapterHealthy: boolean;
  /** Whether there is an open bet */
  openBetExists: boolean;
  /** Whether cooldown has elapsed */
  cooldownElapsed: boolean;
  /** Required stake for next bet */
  requiredStake: number;
  /** Required balance buffer */
  balanceBuffer: number;
  /** Maximum daily entries allowed */
  maxDailyEntries: number;
  /** Minimum confidence required for entry */
  minConfidenceForEntry: 'low' | 'medium' | 'high';
  /** Number of consecutive errors */
  consecutiveErrors: number;
  /** Max consecutive errors before stop */
  maxConsecutiveErrors: number;
  /** Number of cash-out failures */
  cashOutFailures: number;
  /** Max cash-out failures before stop */
  maxCashOutFailures: number;
  /**
   * Optional prediction signal from the PredictionEngine.
   * Hard safety conditions always take precedence.
   */
  predictionSignal?: {
    predictionId: string;
    probability: number;
    confidence: number;
    target: number;
    expiresAt: string;
    dataQuality: number;
  } | null;
  minPredictionProbability?: number;
  minPredictionConfidence?: number;
}

/**
 * Result of risk engine evaluation.
 */
export interface RiskEvaluationResult {
  /** Whether the bet is approved */
  approved: boolean;
  /** Detailed condition evaluation results */
  conditions: RiskConditionResults;
  /** Human-readable reason for rejection (null if approved) */
  rejectionReason: string | null;
  /** The first condition that failed (null if all passed) */
  firstFailure: string | null;
}

/**
 * Individual condition evaluation results.
 */
export interface RiskConditionResults {
  modeIsLive: boolean;
  operatorAuthorized: boolean;
  sessionAuthenticated: boolean;
  gameLoaded: boolean;
  roundStateValid: boolean;
  balanceSufficient: boolean;
  dailyEntriesBelowLimit: boolean;
  notPaused: boolean;
  killSwitchOff: boolean;
  browserHealthy: boolean;
  gameAdapterHealthy: boolean;
  observationConfidenceHigh: boolean;
  noOpenBet: boolean;
  cooldownElapsed: boolean;
  errorThresholdOk: boolean;
  cashOutFailureThresholdOk: boolean;
  predictionAcceptable: boolean;
}

// ─── Idempotency Types ───────────────────────────────────────────────────────

/**
 * Status of an idempotency key.
 */
export type IdempotencyStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED' | 'UNKNOWN';

/**
 * Record of an idempotency key.
 */
export interface IdempotencyRecord {
  /** The idempotency key */
  key: string;
  /** Current status */
  status: IdempotencyStatus;
  /** Associated bet ID */
  betId: string | null;
  /** Round ID */
  roundId: string;
  /** Session ID */
  sessionId: string;
  /** When the key was created */
  createdAt: string;
  /** When the key expires */
  expiresAt: string;
  /** Result payload (if completed) */
  result?: BetPlacementResult;
}

/**
 * Configuration for the idempotency store.
 */
export interface IdempotencyConfig {
  /** TTL for idempotency keys in milliseconds */
  ttlMs: number;
  /** Cleanup interval in milliseconds */
  cleanupIntervalMs: number;
}

// ─── Dry-Run Types ───────────────────────────────────────────────────────────

/**
 * Result of a dry-run (simulated) bet.
 */
export interface DryRunResult {
  /** Whether the simulated bet would have won */
  wouldWin: boolean;
  /** The crash point that ended the round */
  crashPoint: number;
  /** Hypothetical P&L */
  hypotheticalPnl: number;
  /** Whether cash-out would have succeeded */
  cashOutWouldSucceed: boolean;
}
