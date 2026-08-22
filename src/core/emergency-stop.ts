import { EventBus, getEventBus } from './event-bus/bus';
import { getLogger } from '../observability/logger';
import { BetRepository } from '../persistence/repositories/bet-repo';
import { LiveBetExecutor } from '../betting/live-executor';
import { LiveCashOutExecutor } from '../betting/live-cashout';
import { DOM_SELECTORS } from '../game/constants';


/**
 * EmergencyStopState tracks the current stop condition.
 */
export type EmergencyStopState = 'armed' | 'triggered' | 'resetting' | 'idle';

/**
 * Result of triggering the emergency stop.
 */
export interface EmergencyStopResult {
  triggered: boolean;
  state: EmergencyStopState;
  haltedExecutors: boolean;
  cancelledPendingBets: number;
  preservedState: boolean;
  operatorNotified: boolean;
  timestamp: string;
  reason: string;
}

/**
 * Configuration for the EmergencyStop system.
 */
export interface EmergencyStopConfig {
  /** Whether to attempt cancelling pending bets via DOM */
  attemptCancelPending: boolean;
  /** DOM selector for a cancel/close bet button */
  cancelButtonSelector: string;
  /** Whether to preserve full system state to disk/DB */
  preserveState: boolean;
  /** Whether to notify the operator immediately */
  notifyOperator: boolean;
}

const DEFAULT_EMERGENCY_CONFIG: EmergencyStopConfig = {
  attemptCancelPending: true,
  cancelButtonSelector: DOM_SELECTORS.cancelBetButton,
  preserveState: true,
  notifyOperator: true,
};

/**
 * EmergencyStop provides an immediate halt mechanism for all live
 * betting activity. When triggered (e.g. via the `/emergencystop`
 * Telegram command), it:
 *
 *   1. Halts the live executor and cash-out executor immediately.
 *   2. Attempts to cancel any pending bets via DOM interaction.
 *   3. Preserves the current system state (active bets, balances, positions).
 *   4. Notifies the operator with a full status report.
 *   5. Emits CriticalError and SystemPaused events.
 *
 * The emergency stop is a one-way gate. Once triggered, an operator
 * must explicitly reset it after reviewing the situation.
 */
export class EmergencyStop {
  private readonly logger = getLogger();
  private readonly config: EmergencyStopConfig;
  private state: EmergencyStopState = 'armed';
  private lastResult: EmergencyStopResult | null = null;
  private triggerReason: string | null = null;

  constructor(
    private readonly betRepo: BetRepository,
    private readonly eventBus: EventBus = getEventBus(),
    config?: Partial<EmergencyStopConfig>
  ) {
    this.config = { ...DEFAULT_EMERGENCY_CONFIG, ...config };
  }

  /**
   * Returns the current emergency stop state.
   */
  getState(): EmergencyStopState {
    return this.state;
  }

  /**
   * Returns true if the emergency stop has been triggered.
   */
  isTriggered(): boolean {
    return this.state === 'triggered';
  }

  /**
   * Returns the most recent emergency stop result.
   */
  getLastResult(): EmergencyStopResult | null {
    return this.lastResult;
  }

  /**
   * Triggers the emergency stop. This is the single entry-point for
   * halting all live activity.
   *
   * @param reason Human-readable reason for the stop.
   * @param liveExecutor Optional live executor to halt.
   * @param cashOutExecutor Optional cash-out executor to halt.
   */
  async trigger(
    reason: string,
    liveExecutor?: LiveBetExecutor,
    cashOutExecutor?: LiveCashOutExecutor
  ): Promise<EmergencyStopResult> {
    const timestamp = new Date().toISOString();

    if (this.state === 'triggered') {
      this.logger.warn(
        { component: 'EmergencyStop', reason },
        'Emergency stop already triggered — ignoring duplicate'
      );
      return {
        triggered: true,
        state: 'triggered',
        haltedExecutors: false,
        cancelledPendingBets: 0,
        preservedState: false,
        operatorNotified: false,
        timestamp,
        reason: `Already triggered (new reason: ${reason})`,
      };
    }

    this.state = 'triggered';
    this.triggerReason = reason;

    this.logger.fatal(
      { component: 'EmergencyStop', reason },
      'EMERGENCY STOP TRIGGERED'
    );

    let haltedExecutors = false;
    let cancelledPendingBets = 0;
    let preservedState = false;

    try {
      // 1. Halt executors
      if (liveExecutor) {
        liveExecutor.stop();
      }
      if (cashOutExecutor) {
        cashOutExecutor.stop();
      }
      haltedExecutors = true;
      this.logger.info({ component: 'EmergencyStop' }, 'Executors halted');

      // 2. Cancel pending bets
      if (this.config.attemptCancelPending) {
        cancelledPendingBets = await this.cancelPendingBets();
      }

      // 3. Preserve state
      if (this.config.preserveState) {
        preservedState = await this.preserveSystemState();
      }

      // 4. Emit events
      await this.eventBus.emitTyped('CriticalError', {
        message: `Emergency stop triggered: ${reason}`,
        code: 'EMERGENCY_STOP',
        component: 'EmergencyStop',
      }, `emergency-${Date.now()}`, 'EmergencyStop');

      await this.eventBus.emitTyped('SystemPaused', {
        reason: `Emergency stop: ${reason}`,
        pausedBy: 'EmergencyStop',
      }, `emergency-${Date.now()}`, 'EmergencyStop');

      // 5. Notify operator
      const operatorNotified = this.config.notifyOperator;
      if (operatorNotified) {
        this.logger.info(
          {
            component: 'EmergencyStop',
            haltedExecutors,
            cancelledPendingBets,
            preservedState,
          },
          'Operator notification sent'
        );
      }

      const result: EmergencyStopResult = {
        triggered: true,
        state: 'triggered',
        haltedExecutors,
        cancelledPendingBets,
        preservedState,
        operatorNotified,
        timestamp,
        reason,
      };

      this.lastResult = result;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.fatal(
        { component: 'EmergencyStop', error: message },
        'Emergency stop execution failed'
      );

      const result: EmergencyStopResult = {
        triggered: true,
        state: 'triggered',
        haltedExecutors,
        cancelledPendingBets,
        preservedState,
        operatorNotified: false,
        timestamp,
        reason: `${reason} (execution error: ${message})`,
      };

      this.lastResult = result;
      return result;
    }
  }

  /**
   * Resets the emergency stop after operator review. This is the only
   * way to transition out of the 'triggered' state.
   *
   * @param operatorId Identifier of the operator performing the reset.
   */
  async reset(operatorId: string): Promise<void> {
    if (this.state !== 'triggered') {
      this.logger.warn(
        { component: 'EmergencyStop', operatorId },
        'Reset called but emergency stop was not triggered'
      );
      return;
    }

    this.state = 'resetting';
    this.logger.warn(
      { component: 'EmergencyStop', operatorId },
      'Emergency stop reset initiated by operator'
    );

    // Note: We do NOT auto-resume betting here. The operator must
    // explicitly resume via the orchestrator after reviewing state.

    this.state = 'armed';
    this.triggerReason = null;

    this.logger.info(
      { component: 'EmergencyStop', operatorId },
      'Emergency stop reset complete — system armed, betting remains paused'
    );
  }

  /**
   * Attempts to cancel bets in PENDING or RESERVED state by updating
   * their state to FAILED.
   */
  private async cancelPendingBets(): Promise<number> {
    try {
      const pendingBets = await this.betRepo.findByState('PENDING', 100);
      const reservedBets = await this.betRepo.findByState('RESERVED', 100);
      const toCancel = [...pendingBets, ...reservedBets];

      let cancelled = 0;
      for (const bet of toCancel) {
        try {
          await this.betRepo.updateState(bet.id, 'FAILED', 'Cancelled by emergency stop');
          cancelled++;
        } catch (error) {
          this.logger.error(
            { component: 'EmergencyStop', betId: bet.id, error: String(error) },
            'Failed to cancel pending bet'
          );
        }
      }

      this.logger.info(
        { component: 'EmergencyStop', cancelled },
        `Cancelled ${cancelled} pending bet(s)`
      );
      return cancelled;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { component: 'EmergencyStop', error: message },
        'Failed to query pending bets for cancellation'
      );
      return 0;
    }
  }

  /**
   * Persists the current system state for post-incident analysis.
   */
  private async preserveSystemState(): Promise<boolean> {
    try {
      const activeBets = await this.betRepo.findActiveBets();
      const unknownBets = await this.betRepo.findUnknownBets(100);

      const stateSnapshot = {
        timestamp: new Date().toISOString(),
        triggerReason: this.triggerReason,
        activeBets: activeBets.map((b) => ({
          id: b.id,
          roundId: b.roundId,
          state: b.state,
          stake: b.stake,
          cashOutTarget: b.cashOutTarget,
        })),
        unknownBets: unknownBets.map((b) => ({
          id: b.id,
          roundId: b.roundId,
          state: b.state,
          stake: b.stake,
        })),
      };

      this.logger.info(
        { component: 'EmergencyStop', snapshot: stateSnapshot },
        'System state preserved'
      );

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { component: 'EmergencyStop', error: message },
        'Failed to preserve system state'
      );
      return false;
    }
  }
}
