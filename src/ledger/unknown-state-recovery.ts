import { BetRepository, BetRecord } from '../persistence/repositories/bet-repo';
import { RoundRepository } from '../persistence/repositories/round-repo';
import { getLogger } from '../observability/logger';
import { EventBus, getEventBus } from '../core/event-bus/bus';
import { CriticalError } from '../utils/errors';
import { BetState } from '../types/betting';

/**
 * Result of recovering a single UNKNOWN bet.
 */
export interface BetRecoveryResult {
  betId: string;
  previousState: BetState;
  newState: BetState;
  resolved: boolean;
  reason: string;
  pnl?: number | null;
  multiplier?: number | null;
}

/**
 * Result of a full recovery sweep.
 */
export interface RecoverySweepResult {
  totalUnknown: number;
  resolved: number;
  manualReviewRequired: number;
  stillUnknown: number;
  results: BetRecoveryResult[];
  timestamp: string;
}

/**
 * Configuration for unknown-state recovery.
 */
export interface SettlementEvidence {
  /** Authoritative external status; null means not established. */
  status: 'CASHED_OUT' | 'LOST' | 'FAILED' | null;
  /** Server-side cash-out multiplier, when the external system confirms it. */
  cashOutMultiplier: number | null;
  /** External transaction/bet identifier, when available. */
  externalReference: string | null;
  /** Human-readable provenance/evidence description. */
  source: string;
  /** Raw evidence retained for audit. */
  evidence: Record<string, unknown>;
}

export interface SettlementEvidenceProvider {
  getSettlementEvidence(bet: BetRecord): Promise<SettlementEvidence>;
}

export interface UnknownStateRecoveryConfig {
  maxBetsPerSweep: number;
  escalationTimeoutMs: number;
}

const DEFAULT_RECOVERY_CONFIG: UnknownStateRecoveryConfig = {
  maxBetsPerSweep: 50,
  escalationTimeoutMs: 300000,
};

/**
 * UNKNOWN recovery is deliberately evidence-driven. Round crash points are
 * observations of the game, not proof that our user's wager settled. An
 * UNKNOWN bet may only be moved to a terminal financial state when an
 * authoritative external settlement provider confirms it.
 */
export class UnknownStateRecovery {
  private readonly logger = getLogger();
  private readonly config: UnknownStateRecoveryConfig;
  private isReconciling = false;

  constructor(
    private readonly betRepo: BetRepository,
    private readonly roundRepo: RoundRepository,
    private readonly eventBus: EventBus = getEventBus(),
    evidenceProviderOrConfig?: SettlementEvidenceProvider | Partial<UnknownStateRecoveryConfig>,
    config?: Partial<UnknownStateRecoveryConfig>
  ) {
    this.evidenceProvider = evidenceProviderOrConfig && typeof (evidenceProviderOrConfig as SettlementEvidenceProvider).getSettlementEvidence === 'function'
      ? evidenceProviderOrConfig as SettlementEvidenceProvider
      : undefined;
    const legacyConfig = this.evidenceProvider ? config : evidenceProviderOrConfig as Partial<UnknownStateRecoveryConfig> | undefined;
    this.config = { ...DEFAULT_RECOVERY_CONFIG, ...legacyConfig };
  }

  private readonly evidenceProvider?: SettlementEvidenceProvider;

  isReconcilingNow(): boolean { return this.isReconciling; }

  async runRecoverySweep(): Promise<RecoverySweepResult> {
    if (this.isReconciling) {
      return { totalUnknown: 0, resolved: 0, manualReviewRequired: 0, stillUnknown: 0, results: [], timestamp: new Date().toISOString() };
    }
    this.isReconciling = true;
    const timestamp = new Date().toISOString();
    try {
      const unknownBets = await this.betRepo.findUnknownBets(this.config.maxBetsPerSweep);
      const results: BetRecoveryResult[] = [];
      let resolved = 0;
      for (const bet of unknownBets) {
        const result = await this.recoverBet(bet);
        results.push(result);
        if (result.resolved) resolved++;
      }
      const manualReviewRequired = results.length - resolved;
      if (manualReviewRequired > 0) {
        await this.eventBus.emitTyped('CriticalError', {
          message: `${manualReviewRequired} bet(s) remain UNKNOWN after evidence-driven recovery`,
          code: 'UNKNOWN_BETS_REMAINING', component: 'UnknownStateRecovery',
        }, `recovery-${Date.now()}`, 'UnknownStateRecovery');
      }
      return { totalUnknown: unknownBets.length, resolved, manualReviewRequired, stillUnknown: manualReviewRequired, results, timestamp };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'UnknownStateRecovery', error: message }, 'Recovery sweep failed');
      throw new CriticalError(`Recovery sweep failed: ${message}`, 'RECOVERY_SWEEP_FAILED');
    } finally {
      this.isReconciling = false;
    }
  }

  async recoverBet(bet: BetRecord): Promise<BetRecoveryResult> {
    const betId = bet.id;
    const roundId = bet.roundId;
    if (!roundId) {
      return { betId, previousState: 'UNKNOWN', newState: 'UNKNOWN', resolved: false, reason: 'Bet has no roundId — manual review required' };
    }
    try {
      const round = await this.roundRepo.findById(roundId);
      if (!round) {
        return { betId, previousState: 'UNKNOWN', newState: 'UNKNOWN', resolved: false, reason: `Round ${roundId} not found in history` };
      }
      if (!this.evidenceProvider) {
        const crashPoint = round.finalConfirmedCrashPoint ?? round.observedCrashPoint;
        const reason = crashPoint === null
          ? 'Round has no crash point and no authoritative settlement provider is configured'
          : `Round ended at ${crashPoint}x, but round outcome does not prove our bet settled; authoritative evidence required`;
        this.logger.warn({ component: 'UnknownStateRecovery', betId, roundId, crashPoint }, reason);
        return { betId, previousState: 'UNKNOWN', newState: 'UNKNOWN', resolved: false, reason };
      }

      const evidence = await this.evidenceProvider.getSettlementEvidence(bet);
      if (!evidence.status) {
        return { betId, previousState: 'UNKNOWN', newState: 'UNKNOWN', resolved: false, reason: `Authoritative settlement unavailable (${evidence.source})` };
      }

      const newState = evidence.status === 'CASHED_OUT' ? 'CASHED_OUT' : evidence.status === 'LOST' ? 'LOST' : 'FAILED';
      const multiplier = evidence.status === 'CASHED_OUT' ? evidence.cashOutMultiplier : null;
      const pnl = evidence.status === 'CASHED_OUT' && multiplier !== null
        ? Math.round((bet.stake * multiplier - bet.stake) * 100) / 100
        : evidence.status === 'LOST' ? -bet.stake : 0;

      await this.betRepo.update(betId, {
        state: newState,
        confirmedCashOutMultiplier: multiplier,
        observedCashOutMultiplier: multiplier,
        pnl,
        failureReason: `Authoritative settlement: ${evidence.source}; externalReference=${evidence.externalReference ?? 'none'}`,
        externalReference: evidence.externalReference,
        settlementSource: evidence.source,
        settlementEvidence: evidence.evidence,
      });

      return { betId, previousState: 'UNKNOWN', newState, resolved: true, reason: `Authoritative settlement confirmed ${newState}: ${evidence.source}`, pnl, multiplier };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'UnknownStateRecovery', betId, roundId, error: message }, 'Error recovering bet');
      return { betId, previousState: 'UNKNOWN', newState: 'UNKNOWN', resolved: false, reason: `Recovery error: ${message}` };
    }
  }

  /**
   * Manually resolves a bet to a specific state. Used by operators
   * when automatic recovery cannot determine the outcome.
   */
  async manualResolve(
    betId: string,
    newState: 'CASHED_OUT' | 'LOST' | 'RECONCILED',
    pnl: number,
    multiplier?: number,
    reason?: string
  ): Promise<BetRecoveryResult> {
    const bet = await this.betRepo.findById(betId);
    if (!bet) {
      throw new CriticalError(`Bet ${betId} not found for manual resolution`, 'MANUAL_RESOLVE_NOT_FOUND');
    }
    if (bet.state !== 'UNKNOWN') {
      throw new CriticalError(
        `Bet ${betId} is in state ${bet.state}, not UNKNOWN — cannot manually resolve`,
        'MANUAL_RESOLVE_INVALID_STATE'
      );
    }

    await this.betRepo.update(betId, {
      state: newState,
      confirmedCashOutMultiplier: multiplier ?? null,
      observedCashOutMultiplier: multiplier ?? null,
      pnl,
    });

    const resolvedReason = reason ?? `Manually resolved to ${newState} by operator`;
    this.logger.info(
      { component: 'UnknownStateRecovery', betId, newState, pnl, reason: resolvedReason },
      'Bet manually resolved'
    );

    return {
      betId,
      previousState: 'UNKNOWN',
      newState,
      resolved: true,
      reason: resolvedReason,
      pnl,
      multiplier,
    };
  }
}
