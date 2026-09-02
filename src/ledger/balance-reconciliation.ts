import { BetRepository } from '../persistence/repositories/bet-repo';
import { BalanceTracker } from './balance-tracker';
import { getLogger } from '../observability/logger';
import { EventBus, getEventBus } from '../core/event-bus/bus';
import { CriticalError } from '../utils/errors';

/**
 * Result of a balance reconciliation check.
 */
export interface ReconciliationResult {
  reconciled: boolean;
  expectedBalance: number;
  actualBalance: number;
  difference: number;
  withinTolerance: boolean;
  tolerance: number;
  unresolvedBets: number;
  alertSent: boolean;
  timestamp: string;
}

/**
 * Configuration for balance reconciliation.
 */
export interface BalanceReconciliationConfig {
  /** Tolerance for balance mismatch (absolute units) */
  tolerance: number;
  /** Maximum number of unresolved bets allowed before escalating */
  maxUnresolvedBets: number;
  /** Whether to emit alert events on mismatch */
  emitAlerts: boolean;
  /** Whether to halt betting on significant mismatch */
  haltOnMismatch: boolean;
  /** Threshold for "significant" mismatch (absolute units) */
  significantMismatchThreshold: number;
}

const DEFAULT_CONFIG: BalanceReconciliationConfig = {
  tolerance: 0.01,
  maxUnresolvedBets: 0,
  emitAlerts: true,
  haltOnMismatch: true,
  significantMismatchThreshold: 100,
};

/**
 * BalanceReconciliation continuously compares the expected balance
 * (derived from the ledger of settled bets) against the actual balance
 * observed from the game interface. Any discrepancy is flagged immediately
 * and the operator is alerted.
 *
 * Expected balance = starting_balance + sum(all_confirmed_pnl)
 *
 * The reconciler also tracks unresolved bets (UNKNOWN state) because
 * they represent unconfirmed PnL that cannot be included in the expected
 * balance calculation.
 */
export class BalanceReconciliation {
  private readonly logger = getLogger();
  private readonly config: BalanceReconciliationConfig;
  private readonly injectedPool: { query: (q: string, a?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } | null = null;
  private lastResult: ReconciliationResult | null = null;
  private consecutiveMismatches = 0;
  private maxConsecutiveMismatches = 3;

  constructor(
    private readonly betRepo: BetRepository,
    private readonly balanceTracker: BalanceTracker,
    private readonly eventBus: EventBus = getEventBus(),
    config?: Partial<BalanceReconciliationConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Runs a full reconciliation cycle:
   *   1. Compute expected balance from ledger.
   *   2. Read actual balance from tracker.
   *   3. Compare and flag discrepancies.
   *   4. Alert operator if mismatch detected.
   *
   * Returns the reconciliation result.
   */
  async reconcile(actualBalance?: number): Promise<ReconciliationResult> {
    const timestamp = new Date().toISOString();

    // 1. Compute expected balance from all settled bets
    const expectedBalance = await this.computeExpectedBalance();

    // 2. Get actual balance
    const resolvedActual = actualBalance ?? this.balanceTracker.getCurrentBalance();
    if (resolvedActual === null) {
      const result: ReconciliationResult = {
        reconciled: false,
        expectedBalance,
        actualBalance: NaN,
        difference: NaN,
        withinTolerance: false,
        tolerance: this.config.tolerance,
        unresolvedBets: await this.countUnresolvedBets(),
        alertSent: false,
        timestamp,
      };
      this.logger.error(
        { component: 'BalanceReconciliation', expectedBalance },
        'Cannot reconcile — actual balance is unknown'
      );
      this.lastResult = result;
      return result;
    }

    // 3. Compare
    const difference = Math.round((resolvedActual - expectedBalance) * 100) / 100;
    const withinTolerance = Math.abs(difference) <= this.config.tolerance;
    const unresolvedBets = await this.countUnresolvedBets();

    const result: ReconciliationResult = {
      reconciled: withinTolerance && unresolvedBets === 0,
      expectedBalance,
      actualBalance: resolvedActual,
      difference,
      withinTolerance,
      tolerance: this.config.tolerance,
      unresolvedBets,
      alertSent: false,
      timestamp,
    };

    // 4. Handle mismatch
    if (!withinTolerance) {
      this.consecutiveMismatches++;
      result.alertSent = await this.handleMismatch(result);
    } else {
      this.consecutiveMismatches = 0;
      if (unresolvedBets > 0) {
        this.logger.warn(
          {
            component: 'BalanceReconciliation',
            expectedBalance,
            actualBalance: resolvedActual,
            unresolvedBets,
          },
          'Balance matches but unresolved bets exist'
        );
      } else {
        this.logger.debug(
          {
            component: 'BalanceReconciliation',
            expectedBalance,
            actualBalance: resolvedActual,
          },
          'Balance reconciled'
        );
      }
    }

    this.lastResult = result;
    return result;
  }

  /**
   * Computes the expected balance by summing all confirmed PnL
   * from settled bets and adding it to the initial balance.
   *
   * For simplicity, we use the earliest balance_before as the baseline
   * and add all confirmed PnL since then.
   */
  async computeExpectedBalance(): Promise<number> {
    try {
      // Prefer SQL aggregates — never silently cap at 1000 rows
      const pool = this.injectedPool ?? (this.betRepo as unknown as { pool?: { query: (q: string, a?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } }).pool;
      if (pool?.query) {
        const agg = await pool.query(
          `WITH snap AS (
             SELECT balance, captured_at FROM balance_snapshots
             ORDER BY captured_at DESC LIMIT 1
           )
           SELECT
             COALESCE((SELECT balance FROM snap), (
               SELECT balance_before FROM bets
               WHERE balance_before IS NOT NULL
               ORDER BY created_at DESC LIMIT 1
             ))::float8 AS baseline,
             COALESCE((
               SELECT SUM(pnl) FROM bets
               WHERE state IN ('CASHED_OUT','LOST','FAILED','RECONCILED')
                 AND (
                   NOT EXISTS (SELECT 1 FROM snap)
                   OR created_at > (SELECT captured_at FROM snap)
                 )
             ), 0)::float8 AS total_pnl`
        );
        const row = agg.rows[0] ?? {};
        const totalPnL = Number(row.total_pnl ?? 0);
        const baselineBalance = row.baseline != null ? Number(row.baseline) : null;
        if (baselineBalance === null || !Number.isFinite(baselineBalance)) {
          return this.balanceTracker.getCurrentBalance() ?? 0;
        }
        return Math.round((baselineBalance + totalPnL) * 100) / 100;
      }

      // Fallback: paginate until exhausted (no silent 1000 cap)
      const settledStates = ['CASHED_OUT', 'LOST', 'FAILED', 'RECONCILED'] as const;
      let totalPnL = 0;
      let baselineBalance: number | null = null;
      for (const state of settledStates) {
        let offset = 0;
        const pageSize = 1000;
        for (;;) {
          const bets =
            typeof (this.betRepo as unknown as { findByStatePaged?: Function }).findByStatePaged === 'function'
              ? await (this.betRepo as unknown as { findByStatePaged: (s: string, limit: number, offset: number) => Promise<Array<{ pnl: number | null; balanceBefore: number | null }>> }).findByStatePaged(state, pageSize, offset)
              : await this.betRepo.findByState(state, pageSize);
          if (!bets.length) break;
          for (const bet of bets) {
            if (bet.pnl !== null) totalPnL += bet.pnl;
            if (baselineBalance === null && bet.balanceBefore !== null) {
              baselineBalance = bet.balanceBefore;
            }
          }
          if (bets.length < pageSize) break;
          offset += pageSize;
          // Safety: if repo ignores offset, avoid infinite loop
          if (offset > 1_000_000) {
            this.logger.warn(
              { component: 'BalanceReconciliation', state, offset },
              'Reconciliation pagination safety stop'
            );
            break;
          }
        }
      }
      if (baselineBalance === null) {
        return this.balanceTracker.getCurrentBalance() ?? 0;
      }
      return Math.round((baselineBalance + totalPnL) * 100) / 100;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { component: 'BalanceReconciliation', error: message },
        'Failed to compute expected balance'
      );
      throw new CriticalError(`Balance computation failed: ${message}`, 'RECONCILE_COMPUTE_FAILED');
    }
  }

  /**
   * Returns the number of bets in UNKNOWN state.
   */
  async countUnresolvedBets(): Promise<number> {
    try {
      return await this.betRepo.countByState('UNKNOWN');
    } catch {
      return 0;
    }
  }

  /**
   * Returns the most recent reconciliation result.
   */
  getLastResult(): ReconciliationResult | null {
    return this.lastResult;
  }

  /**
   * Returns true if the last reconciliation detected a mismatch.
   */
  hasMismatch(): boolean {
    return this.lastResult !== null && !this.lastResult.withinTolerance;
  }

  /**
   * Returns true if betting should be halted due to repeated mismatches.
   */
  shouldHalt(): boolean {
    return this.consecutiveMismatches >= this.maxConsecutiveMismatches;
  }

  /**
   * Handles a detected mismatch: logs, alerts, and optionally halts.
   */
  private async handleMismatch(result: ReconciliationResult): Promise<boolean> {
    const isSignificant = Math.abs(result.difference) >= this.config.significantMismatchThreshold;

    this.logger.error(
      {
        component: 'BalanceReconciliation',
        expectedBalance: result.expectedBalance,
        actualBalance: result.actualBalance,
        difference: result.difference,
        tolerance: result.tolerance,
        unresolvedBets: result.unresolvedBets,
        consecutiveMismatches: this.consecutiveMismatches,
        significant: isSignificant,
      },
      'BALANCE MISMATCH DETECTED'
    );

    if (this.config.emitAlerts) {
      await this.eventBus.emitTyped('CriticalError', {
        message: `Balance mismatch: expected ${result.expectedBalance}, actual ${result.actualBalance}, diff ${result.difference}`,
        code: 'BALANCE_MISMATCH',
        component: 'BalanceReconciliation',
      }, `reconcile-${Date.now()}`, 'BalanceReconciliation');
    }

    if (this.config.haltOnMismatch && this.shouldHalt()) {
      this.logger.fatal(
        { component: 'BalanceReconciliation' },
        'HALTING — too many consecutive balance mismatches'
      );
      await this.eventBus.emitTyped('SystemPaused', {
        reason: `Balance mismatch exceeded threshold: ${this.consecutiveMismatches} consecutive mismatches`,
        pausedBy: 'BalanceReconciliation',
      }, `halt-${Date.now()}`, 'BalanceReconciliation');
    }

    return this.config.emitAlerts;
  }
}
