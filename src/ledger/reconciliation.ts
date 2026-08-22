import { getLogger } from '../observability/logger';
import {
  ReconciliationResult,
  ReconciliationResolution,
  ReconciliationSource,
  ManualOverrideRequest,
} from './types';

/**
 * ReconciliationEngine resolves UNKNOWN bet states after system crashes,
 * restarts, or communication failures.
 *
 * When a bet is in UNKNOWN state, the system cannot safely continue betting
 * until the bet's true outcome is determined. The reconciliation engine:
 *
 * 1. Queries the game adapter for round history
 * 2. Checks balance changes
 * 3. Attempts to determine if the bet was cashed out or lost
 * 4. Falls back to manual operator override if automatic resolution fails
 *
 * Design principle: when in doubt, the bet stays UNKNOWN and the system
 * remains in RECONCILING state until an operator resolves it.
 */
export class ReconciliationEngine {
  private readonly logger = getLogger();

  /**
   * Reconcile an unknown bet using available evidence.
   *
   * @param betId The bet to reconcile
   * @param roundId The round the bet was placed on
   * @param stake The stake amount
   * @param target The cash-out target
   * @param evidence Evidence from various sources
   */
  async reconcile(params: {
    betId: string;
    roundId: string;
    stake: number;
    target: number;
    evidence: {
      /** Crash point from round history (null if unavailable) */
      crashPoint: number | null;
      /** Balance before the bet */
      balanceBefore: number | null;
      /** Balance after the round */
      balanceAfter: number | null;
      /** Whether the game API shows a cash-out for this bet */
      gameApiShowsCashOut: boolean | null;
      /** Multiplier from game API (null if not cashed out) */
      gameApiMultiplier: number | null;
      /** True only when the balance delta is independently attributable to this bet. */
      balanceDeltaIsolated?: boolean;
      /** External transaction/bet reference proving settlement, when available. */
      externalReference?: string | null;
    };
  }): Promise<ReconciliationResult> {
    const { betId, roundId, stake, target, evidence } = params;

    this.logger.info(
      {
        component: 'ReconciliationEngine',
        betId,
        roundId,
        crashPoint: evidence.crashPoint,
        gameApiShowsCashOut: evidence.gameApiShowsCashOut,
      },
      'Starting reconciliation'
    );

    // Strategy 1: Game API is the most authoritative source
    if (evidence.gameApiShowsCashOut === true && evidence.gameApiMultiplier !== null) {
      const pnl = stake * (evidence.gameApiMultiplier - 1);
      return this.buildResult(betId, 'CASHED_OUT', pnl, evidence.gameApiMultiplier, 'Game API confirms cash-out', 'game_api');
    }

    if (evidence.gameApiShowsCashOut === false) {
      return this.buildResult(betId, 'LOST', null, null, 'Game API confirms no cash-out — bet lost', 'game_api');
    }

    // Strategy 2: balance evidence is only authoritative when the caller has
    // independently isolated the delta to this exact bet. A raw balance change
    // is never sufficient because deposits, withdrawals, bonuses, fees and
    // concurrent activity can produce the same amount.
    if (evidence.balanceDeltaIsolated && evidence.balanceBefore !== null && evidence.balanceAfter !== null) {
      const expectedWin = stake * (target - 1);
      const expectedLoss = -stake;
      const actualChange = evidence.balanceAfter - evidence.balanceBefore;
      if (Math.abs(actualChange - expectedWin) < 0.01) {
        return this.buildResult(betId, 'CASHED_OUT', expectedWin, target, 'Isolated balance delta matches win amount', 'balance');
      }
      if (Math.abs(actualChange - expectedLoss) < 0.01) {
        return this.buildResult(betId, 'LOST', expectedLoss, null, 'Isolated balance delta matches loss amount', 'balance');
      }
      if (Math.abs(actualChange) < 0.01) {
        return this.buildResult(betId, 'FAILED', 0, null, 'Isolated balance delta shows no settlement movement', 'balance');
      }
    }

    // Strategy 3: crash-point analysis is observation only and can never settle
    // an UNKNOWN bet. Even a crash above target does not prove a cash-out.
    // A crash below target proves the round outcome, but not that the bet was
    // accepted, so it is also insufficient without authoritative settlement.
    // Strategy 3: observation only
    if (evidence.crashPoint !== null) {
      if (evidence.crashPoint >= target) {
        // Crash point was above target, but we don't know if cash-out succeeded
        // This is ambiguous — cash-out might have failed due to latency
        this.logger.warn(
          { component: 'ReconciliationEngine', betId, crashPoint: evidence.crashPoint, target },
          'Crash point above target but cash-out status unknown — requires manual resolution'
        );
      }
    }

    // No conclusive evidence — remain UNKNOWN
    this.logger.warn(
      { component: 'ReconciliationEngine', betId, roundId },
      'Reconciliation inconclusive — bet remains UNKNOWN'
    );

    return this.buildResult(betId, 'UNKNOWN', null, null, 'Insufficient evidence for automatic reconciliation', 'round_history');
  }

  /**
   * Apply a manual operator override to resolve an unknown bet.
   * This requires explicit operator authorization and is fully audited.
   */
  applyManualOverride(request: ManualOverrideRequest): ReconciliationResult {
    const { betId, targetState, pnl, cashOutMultiplier, reason, operatorId } = request;

    this.logger.warn(
      {
        component: 'ReconciliationEngine',
        betId,
        targetState,
        operatorId,
        reason,
      },
      'Manual override applied to unknown bet'
    );

    const resolvedPnl = targetState === 'CASHED_OUT' ? (pnl ?? 0) : targetState === 'LOST' ? (pnl ?? 0) : null;
    const resolvedMultiplier = targetState === 'CASHED_OUT' ? (cashOutMultiplier ?? null) : null;

    return {
      betId,
      previousState: 'UNKNOWN',
      resolution: targetState,
      pnl: resolvedPnl,
      cashOutMultiplier: resolvedMultiplier,
      reason: `Manual override by ${operatorId}: ${reason}`,
      resolvedAt: new Date().toISOString(),
      manualOverride: true,
    };
  }

  /**
   * Check if a bet state can be automatically reconciled.
   * Returns true only if there is high-confidence evidence.
   */
  canAutoReconcile(evidence: {
    crashPoint: number | null;
    gameApiShowsCashOut: boolean | null;
    gameApiMultiplier: number | null;
    balanceDeltaIsolated?: boolean;
    balanceBefore: number | null;
    balanceAfter: number | null;
  }): boolean {
    // Game API is definitive only when it returns an explicit settlement.
    if (evidence.gameApiShowsCashOut === true && evidence.gameApiMultiplier !== null) return true;
    if (evidence.gameApiShowsCashOut === false) return true;

    // Balance change is sufficient only when explicitly isolated to this bet.
    if (evidence.balanceDeltaIsolated && evidence.balanceBefore !== null && evidence.balanceAfter !== null) {
      const change = evidence.balanceAfter - evidence.balanceBefore;
      if (Math.abs(change) > 0.01) return true;
    }

    return false;
  }

  private buildResult(
    betId: string,
    resolution: ReconciliationResolution,
    pnl: number | null,
    cashOutMultiplier: number | null,
    reason: string,
    source: ReconciliationSource
  ): ReconciliationResult {
    this.logger.info(
      {
        component: 'ReconciliationEngine',
        betId,
        resolution,
        pnl,
        source,
      },
      `Reconciliation resolved: ${resolution}`
    );

    return {
      betId,
      previousState: 'UNKNOWN',
      resolution,
      pnl,
      cashOutMultiplier,
      reason: `${reason} (source: ${source})`,
      resolvedAt: new Date().toISOString(),
      manualOverride: false,
    };
  }
}


