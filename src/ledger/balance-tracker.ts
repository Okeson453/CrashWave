import { getLogger } from '../observability/logger';
import { BalanceSnapshot, BalanceSource, BalanceReconciliationResult } from './types';

/**
 * BalanceTracker reads and reconciles account balance from multiple sources.
 *
 * It maintains a history of balance snapshots and can detect mismatches
 * between expected and observed balances. When sources disagree, it uses
 * a fallback priority: api > websocket > ui > estimated.
 *
 * The tracker does not perform I/O directly — it receives balance updates
 * from external observers (game adapter, API polling, etc.) and provides
 * reconciliation logic.
 */
export class BalanceTracker {
  private readonly logger = getLogger();
  private snapshots: BalanceSnapshot[] = [];
  private readonly maxHistorySize: number;
  private readonly reconciliationTolerance: number;
  private lastKnownBalance: number | null = null;
  private lastKnownSource: BalanceSource | null = null;
  private unparseable = false;

  constructor(options?: { maxHistorySize?: number; reconciliationTolerance?: number }) {
    this.maxHistorySize = options?.maxHistorySize ?? 1000;
    this.reconciliationTolerance = options?.reconciliationTolerance ?? 0.01;
  }

  /**
   * Record a new balance snapshot.
   */
  record(snapshot: BalanceSnapshot): void {
    this.snapshots.push(snapshot);
    this.lastKnownBalance = snapshot.balance;
    this.lastKnownSource = snapshot.source;
    this.unparseable = false;

    // Trim history if it exceeds max size
    if (this.snapshots.length > this.maxHistorySize) {
      this.snapshots = this.snapshots.slice(-this.maxHistorySize);
    }

    this.logger.debug(
      {
        component: 'BalanceTracker',
        balance: snapshot.balance,
        source: snapshot.source,
        roundId: snapshot.roundId,
        betId: snapshot.betId,
      },
      'Balance snapshot recorded'
    );
  }

  /**
   * Get the most recent balance snapshot.
   */
  getLatestSnapshot(): BalanceSnapshot | null {
    if (this.snapshots.length === 0) return null;
    return this.snapshots[this.snapshots.length - 1];
  }

  /**
   * Get the current balance (last known).
   */
  getCurrentBalance(): number | null {
    return this.lastKnownBalance;
  }

  /**
   * Conservative balance for entry decisions (R4).
   * Returns null if never observed or last snapshot was marked unparseable.
   * Optional buffer is subtracted so callers can require headroom.
   */
  getConservativeBalance(buffer = 0): number | null {
    if (this.lastKnownBalance === null || this.unparseable) {
      return null;
    }
    return Math.max(0, this.lastKnownBalance - buffer);
  }

  /** Mark that the last parse attempt failed — forces entry rejection until a good snapshot */
  markUnparseable(reason?: string): void {
    this.unparseable = true;
    this.logger.warn(
      { component: 'BalanceTracker', reason },
      'Balance marked unparseable — new entries blocked until valid snapshot'
    );
  }

  clearUnparseable(): void {
    this.unparseable = false;
  }

  isUnparseable(): boolean {
    return this.unparseable;
  }

  /**
   * Get the source of the current balance.
   */
  getCurrentSource(): BalanceSource | null {
    return this.lastKnownSource;
  }

  /**
   * Get all snapshots within a time range.
   */
  getSnapshotsInRange(start: Date, end: Date): BalanceSnapshot[] {
    return this.snapshots.filter((s) => {
      const ts = new Date(s.timestamp);
      return ts >= start && ts <= end;
    });
  }

  /**
   * Get the snapshot immediately before a given timestamp.
   */
  getSnapshotBefore(timestamp: Date): BalanceSnapshot | null {
    const before = this.snapshots.filter((s) => new Date(s.timestamp) < timestamp);
    return before.length > 0 ? before[before.length - 1] : null;
  }

  /**
   * Get the snapshot immediately after a given timestamp.
   */
  getSnapshotAfter(timestamp: Date): BalanceSnapshot | null {
    const after = this.snapshots.filter((s) => new Date(s.timestamp) > timestamp);
    return after.length > 0 ? after[0] : null;
  }

  /**
   * Reconcile observed balance against expected balance.
   *
   * Expected balance is typically: previous_balance - stake + winnings.
   * This method checks if the observed balance matches within tolerance.
   */
  reconcile(observedBalance: number, expectedBalance: number): BalanceReconciliationResult {
    const difference = observedBalance - expectedBalance;
    const withinTolerance = Math.abs(difference) <= this.reconciliationTolerance;

    let message: string;
    if (withinTolerance) {
      message = `Balance reconciled: observed=${observedBalance.toFixed(2)}, expected=${expectedBalance.toFixed(2)}, diff=${difference.toFixed(2)}`;
    } else {
      message = `Balance mismatch: observed=${observedBalance.toFixed(2)}, expected=${expectedBalance.toFixed(2)}, diff=${difference.toFixed(2)} (tolerance=${this.reconciliationTolerance})`;
    }

    if (!withinTolerance) {
      this.logger.warn(
        {
          component: 'BalanceTracker',
          observedBalance,
          expectedBalance,
          difference,
          tolerance: this.reconciliationTolerance,
        },
        message
      );
    }

    return {
      matched: withinTolerance,
      observedBalance,
      expectedBalance,
      difference,
      withinTolerance,
      tolerance: this.reconciliationTolerance,
      message,
    };
  }

  /**
   * Reconcile using the latest recorded snapshot as the expected balance.
   */
  reconcileWithLatest(observedBalance: number): BalanceReconciliationResult | null {
    const latest = this.getLatestSnapshot();
    if (!latest) return null;
    return this.reconcile(observedBalance, latest.balance);
  }

  /**
   * Calculate expected balance after a bet outcome.
   */
  calculateExpectedBalance(
    balanceBefore: number,
    _stake: number,
    pnl: number | null
  ): number {
    if (pnl === null) {
      // Bet outcome unknown — balance should not have changed
      return balanceBefore;
    }
    return balanceBefore + pnl;
  }

  /**
   * Detect unexpected balance changes between two snapshots.
   * Returns true if the change cannot be explained by known bets.
   */
  detectAnomaly(
    previousSnapshot: BalanceSnapshot,
    currentSnapshot: BalanceSnapshot,
    knownPnls: number[]
  ): { anomaly: boolean; expectedChange: number; actualChange: number; unexplained: number } {
    const expectedChange = knownPnls.reduce((sum, pnl) => sum + pnl, 0);
    const actualChange = currentSnapshot.balance - previousSnapshot.balance;
    const unexplained = actualChange - expectedChange;
    const anomaly = Math.abs(unexplained) > this.reconciliationTolerance;

    if (anomaly) {
      this.logger.warn(
        {
          component: 'BalanceTracker',
          previousBalance: previousSnapshot.balance,
          currentBalance: currentSnapshot.balance,
          expectedChange,
          actualChange,
          unexplained,
        },
        'Unexpected balance change detected'
      );
    }

    return { anomaly, expectedChange, actualChange, unexplained };
  }

  /**
   * Get the balance trend (average change per snapshot over the last N snapshots).
   */
  getTrend(snapshotCount: number = 10): { direction: 'up' | 'down' | 'flat'; averageChange: number } {
    const recent = this.snapshots.slice(-snapshotCount);
    if (recent.length < 2) {
      return { direction: 'flat', averageChange: 0 };
    }

    let totalChange = 0;
    for (let i = 1; i < recent.length; i++) {
      totalChange += recent[i].balance - recent[i - 1].balance;
    }

    const averageChange = totalChange / (recent.length - 1);
    const threshold = this.reconciliationTolerance;

    let direction: 'up' | 'down' | 'flat';
    if (averageChange > threshold) direction = 'up';
    else if (averageChange < -threshold) direction = 'down';
    else direction = 'flat';

    return { direction, averageChange };
  }

  /**
   * Clear all history.
   */
  clear(): void {
    this.snapshots = [];
    this.lastKnownBalance = null;
    this.lastKnownSource = null;
  }

  /**
   * Get total number of snapshots recorded.
   */
  getHistorySize(): number {
    return this.snapshots.length;
  }
}

/**
 * Balance source priority for fallback resolution.
 */
export const BALANCE_SOURCE_PRIORITY: BalanceSource[] = ['api', 'websocket', 'ui', 'estimated'];

/**
 * Resolve the best balance from multiple sources.
 */
export function resolveBestBalance(
  sources: Partial<Record<BalanceSource, number>>
): { balance: number; source: BalanceSource } | null {
  for (const source of BALANCE_SOURCE_PRIORITY) {
    const value = sources[source];
    if (value !== undefined && value !== null && !isNaN(value)) {
      return { balance: value, source };
    }
  }
  return null;
}
