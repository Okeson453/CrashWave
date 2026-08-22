import { UnknownStateRecovery, RecoverySweepResult } from '../ledger/unknown-state-recovery';
import { BalanceReconciliation, ReconciliationResult } from '../ledger/balance-reconciliation';
import { BetRepository } from '../persistence/repositories/bet-repo';
import { EventBus, getEventBus } from './event-bus/bus';
import { getLogger } from '../observability/logger';


/**
 * RecoveryState describes the current recovery phase.
 */
export type RecoveryPhase =
  | 'idle'
  | 'checking'
  | 'reconciling_bets'
  | 'reconciling_balance'
  | 'resuming'
  | 'failed';

/**
 * Result of a full recovery cycle initiated by the RecoveryManager.
 */
export interface RecoveryResult {
  phase: RecoveryPhase;
  betRecovery: RecoverySweepResult | null;
  balanceReconciliation: ReconciliationResult | null;
  canResume: boolean;
  errors: string[];
  timestamp: string;
}

/**
 * Configuration for the RecoveryManager.
 */
export interface RecoveryManagerConfig {
  /** Whether to halt betting during recovery */
  haltDuringRecovery: boolean;
  /** Max time (ms) to wait for recovery before failing */
  recoveryTimeoutMs: number;
  /** Whether to require zero UNKNOWN bets before resuming */
  requireZeroUnknownBeforeResume: boolean;
  /** Whether to require balance reconciliation before resuming */
  requireBalanceReconciliationBeforeResume: boolean;
}

const DEFAULT_RECOVERY_CONFIG: RecoveryManagerConfig = {
  haltDuringRecovery: true,
  recoveryTimeoutMs: 60000,
  requireZeroUnknownBeforeResume: true,
  requireBalanceReconciliationBeforeResume: true,
};

/**
 * RecoveryManager orchestrates the full recovery pipeline when the system
 * starts up or when an anomaly is detected. It coordinates:
 *
 *   1. Unknown-state bet recovery (via UnknownStateRecovery).
 *   2. Balance reconciliation (via BalanceReconciliation).
 *   3. Decision on whether betting can safely resume.
 *
 * If unknown bets exist on startup, the manager enters RECONCILING mode,
 * halts all new bets, runs the recovery sweep, and only allows resumption
 * when all bets are resolved and the balance reconciles.
 */
export class RecoveryManager {
  private readonly logger = getLogger();
  private readonly config: RecoveryManagerConfig;
  private phase: RecoveryPhase = 'idle';
  private lastResult: RecoveryResult | null = null;
  private halted = false;

  constructor(
    private readonly unknownStateRecovery: UnknownStateRecovery,
    private readonly balanceReconciliation: BalanceReconciliation,
    private readonly betRepo: BetRepository,
    private readonly eventBus: EventBus = getEventBus(),
    config?: Partial<RecoveryManagerConfig>
  ) {
    this.config = { ...DEFAULT_RECOVERY_CONFIG, ...config };
  }

  /**
   * Returns the current recovery phase.
   */
  getPhase(): RecoveryPhase {
    return this.phase;
  }

  /**
   * Returns true if betting should be halted (recovery in progress or
   * unresolved issues exist).
   */
  isHalted(): boolean {
    return this.halted || this.phase !== 'idle';
  }

  /**
   * Returns the most recent recovery result.
   */
  getLastResult(): RecoveryResult | null {
    return this.lastResult;
  }

  /**
   * Initiates a full recovery cycle. This is the entry-point called on
   * system startup and after emergency events.
   *
   * Flow:
   *   1. Check for UNKNOWN bets.
   *   2. If any exist, halt betting and run recovery sweep.
   *   3. Run balance reconciliation.
   *   4. Evaluate whether betting can resume.
   *   5. Emit appropriate events.
   */
  async runRecovery(): Promise<RecoveryResult> {
    const timestamp = new Date().toISOString();
    const errors: string[] = [];

    try {
      this.phase = 'checking';
      this.logger.info({ component: 'RecoveryManager' }, 'Starting recovery check');

      // 1. Check for UNKNOWN bets
      const unknownCount = await this.betRepo.countByState('UNKNOWN');
      this.logger.info(
        { component: 'RecoveryManager', unknownBets: unknownCount },
        `Found ${unknownCount} UNKNOWN bet(s)`
      );

      let betRecovery: RecoverySweepResult | null = null;
      let balanceReconciliation: ReconciliationResult | null = null;

      if (unknownCount > 0 && this.config.haltDuringRecovery) {
        this.halted = true;
        await this.eventBus.emitTyped('SystemPaused', {
          reason: `${unknownCount} UNKNOWN bet(s) detected — entering reconciliation mode`,
          pausedBy: 'RecoveryManager',
        }, `recovery-${Date.now()}`, 'RecoveryManager');
      }

      // 2. Run bet recovery if needed
      if (unknownCount > 0) {
        this.phase = 'reconciling_bets';
        try {
          betRecovery = await this.unknownStateRecovery.runRecoverySweep();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`Bet recovery failed: ${message}`);
          this.logger.error(
            { component: 'RecoveryManager', error: message },
            'Bet recovery sweep failed'
          );
        }
      }

      // 3. Run balance reconciliation
      this.phase = 'reconciling_balance';
      try {
        balanceReconciliation = await this.balanceReconciliation.reconcile();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Balance reconciliation failed: ${message}`);
        this.logger.error(
          { component: 'RecoveryManager', error: message },
          'Balance reconciliation failed'
        );
      }

      // 4. Evaluate resumption
      this.phase = 'resuming';
      const canResume = this.evaluateResumption(betRecovery, balanceReconciliation, errors);

      if (canResume) {
        this.halted = false;
        await this.eventBus.emitTyped('SystemResumed', {
          resumedBy: 'RecoveryManager',
        }, `recovery-${Date.now()}`, 'RecoveryManager');
        this.logger.info(
          { component: 'RecoveryManager' },
          'Recovery complete — betting can resume'
        );
      } else {
        this.halted = true;
        const reason = errors.length > 0
          ? `Recovery incomplete: ${errors.join('; ')}`
          : 'Recovery conditions not met';
        this.logger.warn(
          { component: 'RecoveryManager', reason },
          'Betting remains halted'
        );
      }

      const result: RecoveryResult = {
        phase: canResume ? 'idle' : 'failed',
        betRecovery,
        balanceReconciliation,
        canResume,
        errors,
        timestamp,
      };

      this.lastResult = result;
      this.phase = result.phase;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.fatal(
        { component: 'RecoveryManager', error: message },
        'Recovery manager crashed'
      );
      this.phase = 'failed';
      this.halted = true;

      const result: RecoveryResult = {
        phase: 'failed',
        betRecovery: null,
        balanceReconciliation: null,
        canResume: false,
        errors: [message],
        timestamp,
      };

      this.lastResult = result;
      return result;
    }
  }

  /**
   * Manually clears the halted state. Should only be called by an
   * operator after reviewing unresolved issues.
   */
  async forceResume(operatorId: string, reason: string): Promise<void> {
    if (!operatorId || !reason?.trim()) {
      throw new Error('forceResume requires operatorId and reason');
    }
    const unknownCount = await this.betRepo.countByState('UNKNOWN');
    if (unknownCount > 0) {
      throw new Error(`Cannot force resume while ${unknownCount} UNKNOWN bet(s) remain`);
    }
    this.halted = false;
    this.phase = 'idle';
    this.logger.warn({ component: 'RecoveryManager', operatorId, reason }, 'Force resume triggered by operator');
    await this.eventBus.emitTyped('OperatorCommandReceived', {
      command: 'FORCE_RESUME', operatorId, reason,
    }, `force-resume-${Date.now()}`, 'RecoveryManager');
    await this.eventBus.emitTyped('SystemResumed', {
      resumedBy: operatorId, reason,
    }, `force-resume-${Date.now()}`, 'RecoveryManager');
  }

  /**
   * Evaluates whether all conditions for safe resumption are met.
   */
  private evaluateResumption(
    betRecovery: RecoverySweepResult | null,
    balanceReconciliation: ReconciliationResult | null,
    errors: string[]
  ): boolean {
    // If there are hard errors, don't resume
    if (errors.length > 0) {
      return false;
    }

    // Check unknown bets condition
    if (this.config.requireZeroUnknownBeforeResume) {
      const stillUnknown = betRecovery?.stillUnknown ?? 0;
      if (stillUnknown > 0) {
        return false;
      }
    }

    // Check balance reconciliation condition
    if (this.config.requireBalanceReconciliationBeforeResume && balanceReconciliation) {
      if (!balanceReconciliation.reconciled) {
        return false;
      }
    }

    return true;
  }
}
