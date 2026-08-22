/**
 * Ledger module type definitions.
 *
 * The ledger is the financial accounting layer of the system.
 * It tracks daily entries, balances, P&L, and reconciliation state.
 * All ledger operations must be atomic and auditable.
 */

// ─── Daily Entry Ledger Types ────────────────────────────────────────────────

/**
 * Status of a daily entry slot reservation.
 */
export type EntrySlotStatus = 'RESERVED' | 'CONFIRMED' | 'RELEASED' | 'FAILED';

/**
 * A single daily entry record.
 */
export interface DailyEntryRecord {
  /** Unique identifier */
  id: string;
  /** Daily key (YYYY-MM-DD) */
  dailyKey: string;
  /** Associated bet ID */
  betId: string;
  /** Slot number for this day (1-100) */
  slotNumber: number;
  /** Current status */
  status: EntrySlotStatus;
  /** Session ID that reserved this slot */
  sessionId: string;
  /** When the slot was reserved */
  reservedAt: string;
  /** When the slot was confirmed (null if not confirmed) */
  confirmedAt: string | null;
  /** When the slot was released (null if not released) */
  releasedAt: string | null;
  /** Reason for release/failure */
  reason: string | null;
}

/**
 * Result of attempting to reserve a daily entry slot.
 */
export interface EntryReservationResult {
  /** Whether the reservation succeeded */
  success: boolean;
  /** The reserved slot (null if failed) */
  slot: DailyEntryRecord | null;
  /** Daily key */
  dailyKey: string;
  /** Total confirmed entries after this operation */
  confirmedCount: number;
  /** Total reserved entries after this operation */
  reservedCount: number;
  /** Human-readable message */
  message: string;
}

/**
 * Aggregated daily statistics.
 */
export interface DailyStats {
  dailyKey: string;
  entriesConfirmed: number;
  entriesAttempted: number;
  entriesFailed: number;
  entriesReserved: number;
  entriesRemaining?: number;
  totalBets?: number;
  wins: number;
  losses: number;
  consecutiveLosses?: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  balanceStart: number | null;
  balanceEnd: number | null;
  maxDrawdown: number;
  currentDrawdown: number;
  hitRate: number | null;
  averageLatencyMs: number | null;
  cashOutSuccessRate: number | null;
  updatedAt: string;
  createdAt: string;
}

// ─── Balance Tracker Types ───────────────────────────────────────────────────

/**
 * Source of a balance reading.
 */
export type BalanceSource = 'ui' | 'api' | 'websocket' | 'estimated';

/**
 * A balance snapshot at a point in time.
 */
export interface BalanceSnapshot {
  timestamp: string;
  balance: number;
  currencyOrUnit: string;
  source: BalanceSource;
  roundId?: string;
  betId?: string;
  sessionId?: string;
}

/**
 * Result of a balance reconciliation check.
 */
export interface BalanceReconciliationResult {
  /** Whether the observed balance matches the expected balance */
  matched: boolean;
  /** The observed balance */
  observedBalance: number;
  /** The expected balance (based on ledger) */
  expectedBalance: number;
  /** Difference (observed - expected) */
  difference: number;
  /** Whether the difference is within acceptable tolerance */
  withinTolerance: boolean;
  /** Tolerance used for the check */
  tolerance: number;
  /** Human-readable message */
  message: string;
}

// ─── P&L Calculator Types ────────────────────────────────────────────────────

/**
 * A single P&L entry for the equity curve.
 */
export interface PnlEntry {
  betId: string;
  roundId: string;
  dailyKey: string;
  stake: number;
  target: number;
  outcome: 'win' | 'loss' | 'failed' | 'unknown';
  pnl: number;
  cashOutMultiplier: number | null;
  timestamp: string;
}

/**
 * Equity curve point.
 */
export interface EquityPoint {
  timestamp: string;
  cumulativePnl: number;
  peakPnl: number;
  currentDrawdown: number;
  betId: string;
}

/**
 * P&L summary for a given window.
 */
export interface PnlSummary {
  totalBets: number;
  wins: number;
  losses: number;
  failed: number;
  unknown: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  hitRate: number;
  breakEvenHitRate: number;
  maxDrawdown: number;
  currentDrawdown: number;
  averageWin: number;
  averageLoss: number;
  expectedValue: number;
  winStreakMax: number;
  lossStreakMax: number;
  currentStreak: number;
  currentStreakType: 'win' | 'loss' | 'none';
}

// ─── Reconciliation Types ────────────────────────────────────────────────────

/**
 * Possible resolutions for an UNKNOWN bet state.
 */
export type ReconciliationResolution = 'CASHED_OUT' | 'LOST' | 'FAILED' | 'UNKNOWN';

/**
 * Result of reconciling an unknown bet.
 */
export interface ReconciliationResult {
  betId: string;
  previousState: string;
  resolution: ReconciliationResolution;
  pnl: number | null;
  cashOutMultiplier: number | null;
  reason: string;
  resolvedAt: string;
  manualOverride: boolean;
}

/**
 * Source of truth used for reconciliation.
 */
export type ReconciliationSource = 'balance' | 'round_history' | 'game_api' | 'manual';

/**
 * Request to manually override a bet state.
 */
export interface ManualOverrideRequest {
  betId: string;
  targetState: ReconciliationResolution;
  pnl?: number;
  cashOutMultiplier?: number;
  reason: string;
  operatorId: string;
}
