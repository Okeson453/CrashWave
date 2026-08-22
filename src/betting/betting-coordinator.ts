/**
 * BettingCoordinator — live decision path driver.
 *
 * Round start / crash events → BettingStateMachine + EntryDecisionService → Risk → Executor
 *
 * Prediction never places bets. RiskEngine remains final authority.
 * LiveBetExecutor is only invoked after RISK_APPROVED + ENTRY_APPROVED path.
 */

import { randomUUID } from 'crypto';
import { getLogger } from '../observability/logger.js';
import {
  BettingStateMachine,
  createStateMachine,
} from '../core/state-machine/machine.js';
import { StateMachineConfig, StateMachineEvent } from '../core/state-machine/types.js';
import { EntryConditions } from '../types/betting.js';
import { RoundState } from '../types/game.js';
import { RiskEvaluationInput, RiskConditionResults } from './types.js';
import { EntryDecisionService } from '../prediction/entry-decision-service.js';
import { LiveBetExecutor } from './live-executor.js';
import { AppConfig } from '../config/schema.js';
import { DailyEntryLedger } from '../ledger/daily-entries.js';
import { getDailyKey } from '../utils/day-boundary.js';
import { checkTenantQuota, recordTenantEntry } from '../platform/tenant-quota.js';

export interface BettingCoordinatorOptions {
  config: AppConfig;
  entryDecisionService: EntryDecisionService;
  liveBetExecutor?: LiveBetExecutor | null;
  /** Build risk input from current system state (balance, health, ledger, etc.) */
  buildRiskInput: () => RiskEvaluationInput | Promise<RiskEvaluationInput>;
  sessionId?: string | null;
  onStateChange?: (from: string, to: string, event: StateMachineEvent) => void;
  /** Called after a bet is confirmed placed (for daily ledger counter) */
  onEntryConfirmed?: () => void;
  dailyLedger?: DailyEntryLedger | null;
}

function toEntryConditions(c: RiskConditionResults): EntryConditions {
  return {
    modeIsLive: c.modeIsLive,
    operatorAuthorized: c.operatorAuthorized,
    sessionAuthenticated: c.sessionAuthenticated,
    gameLoaded: c.gameLoaded,
    roundStateValid: c.roundStateValid,
    balanceSufficient: c.balanceSufficient,
    dailyEntriesBelowLimit: c.dailyEntriesBelowLimit,
    notPaused: c.notPaused,
    killSwitchOff: c.killSwitchOff,
    browserHealthy: c.browserHealthy,
    gameAdapterHealthy: c.gameAdapterHealthy,
    observationConfidenceHigh: c.observationConfidenceHigh,
    noOpenBet: c.noOpenBet,
    cooldownElapsed: c.cooldownElapsed,
  };
}

export class BettingCoordinator {
  private readonly logger = getLogger();
  private readonly machine: BettingStateMachine;
  private readonly entryDecisionService: EntryDecisionService;
  private readonly liveBetExecutor: LiveBetExecutor | null;
  private readonly buildRiskInput: () => RiskEvaluationInput | Promise<RiskEvaluationInput>;
  private readonly config: AppConfig;
  private sessionId: string | null;
  private lastPredictionId: string | null = null;
  private evaluating = false;
  private readonly onEntryConfirmed?: () => void;
  private readonly dailyLedger: DailyEntryLedger | null;

  constructor(options: BettingCoordinatorOptions) {
    this.config = options.config;
    this.entryDecisionService = options.entryDecisionService;
    this.liveBetExecutor = options.liveBetExecutor ?? null;
    this.buildRiskInput = options.buildRiskInput;
    this.sessionId = options.sessionId ?? null;
    this.onEntryConfirmed = options.onEntryConfirmed;
    this.dailyLedger = options.dailyLedger ?? null;

    const smConfig: StateMachineConfig = {
      sessionId: options.sessionId ?? 'session-pending',
      initialState: 'OBSERVING',
      contextOverrides: {
        dryRun: options.config.system.mode === 'dry-run',
        browserHealthy: true,
        gameAdapterHealthy: true,
        openBetExists: false,
        paused: false,
        killSwitch: false,
        currentBalance: 50_000,
        lastBetAt: null,
        minConfidenceForEntry: 'high',
        consecutiveErrors: 0,
        cashOutFailures: 0,
      },
      onStateChange: options.onStateChange
        ? (from, to, event) => options.onStateChange?.(from, to, event)
        : undefined,
    };

    this.machine = createStateMachine(smConfig);
  }

  getStateMachine(): BettingStateMachine {
    return this.machine;
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  /**
   * Called when a new round starts and entry may be considered.
   */
  async onRoundStarted(roundId: string, roundState: RoundState): Promise<void> {
    if (this.evaluating) {
      this.logger.warn({ component: 'BettingCoordinator', roundId }, 'Entry evaluation already in progress');
      return;
    }
    this.evaluating = true;
    try {
      // OBSERVING/COOLDOWN → ENTRY_EVALUATING
      const startResult = this.machine.send({
        type: 'ROUND_STARTED',
        roundId,
        roundState,
      });
      if (!startResult.accepted) {
        this.logger.debug(
          { component: 'BettingCoordinator', roundId, message: startResult.message },
          'ROUND_STARTED not accepted'
        );
        return;
      }

      const riskInput = await Promise.resolve(this.buildRiskInput());
      // Ensure round state on risk input matches
      riskInput.roundState = roundState;

      const decision = await this.entryDecisionService.evaluateEntry({
        roundId,
        externalRoundId: roundState.roundId ?? roundId,
        sessionId: this.sessionId,
        decisionTimestamp: new Date().toISOString(),
        riskInput,
        target: 1.3,
        historyLimit: 100,
        minHistory: 20,
      });

      this.lastPredictionId = decision.signal?.predictionId ?? null;

      if (decision.riskResult.approved) {
        const conditions = toEntryConditions(decision.riskResult.conditions);
        const approveResult = this.machine.send({
          type: 'RISK_APPROVED',
          conditions,
        });
        this.logger.info(
          {
            component: 'BettingCoordinator',
            roundId,
            accepted: approveResult.accepted,
            newState: approveResult.newState,
            predictionId: this.lastPredictionId,
          },
          'RISK_APPROVED sent'
        );

        if (approveResult.accepted) {
          await this.tryPlaceBet(roundId);
        }
      } else {
        const rejectResult = this.machine.send({
          type: 'RISK_REJECTED',
          reason: decision.riskResult.rejectionReason ?? 'Risk rejected',
        });
        this.logger.info(
          {
            component: 'BettingCoordinator',
            roundId,
            reason: decision.riskResult.rejectionReason,
            newState: rejectResult.newState,
          },
          'RISK_REJECTED sent'
        );
      }
    } catch (err) {
      this.logger.error(
        {
          component: 'BettingCoordinator',
          roundId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Entry evaluation failed'
      );
      this.machine.send({
        type: 'RISK_REJECTED',
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.evaluating = false;
    }
  }

  /**
   * Called when round crashes — resolve prediction outcome and advance SM.
   */
  async onRoundCrashed(roundId: string, crashPoint: number): Promise<void> {
    try {
      this.machine.send({ type: 'ROUND_CRASHED', crashPoint });

      // Update rolling history buffer (memory) — no DB read on next prediction
      const hist = this.entryDecisionService.getHistoricalDataService();
      hist.onRoundCompleted({
        id: roundId,
        externalRoundId: roundId,
        sessionId: this.sessionId,
        startedAt: null,
        crashedAt: new Date().toISOString(),
        crashPoint,
        observationSource: 'websocket',
        dataQuality: 'high',
        createdAt: new Date().toISOString(),
      });

      // ACIE continuous learning: every crash is a training event
      try {
        this.entryDecisionService.observeCrash(roundId, crashPoint);
      } catch (err) {
        this.logger.warn(
          {
            component: 'BettingCoordinator',
            roundId,
            error: err instanceof Error ? err.message : String(err),
          },
          'ACIE onCrash failed (non-fatal)'
        );
      }

      if (this.lastPredictionId) {
        const target =
          (this.config as { betting?: { cashOutTarget?: number } }).betting?.cashOutTarget ?? 1.3;
        // Non-blocking outcome persistence
        this.entryDecisionService.resolveActualOutcomeAsync({
          predictionId: this.lastPredictionId,
          roundId,
          actualCrashPoint: crashPoint,
          targetThreshold: target,
          betExecuted: this.machine.getContext().openBetExists === true,
        });
        this.lastPredictionId = null;
      }
    } catch (err) {
      this.logger.error(
        {
          component: 'BettingCoordinator',
          roundId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Round crash handling failed'
      );
    }
  }

  private async tryPlaceBet(roundId: string): Promise<void> {
    const mode = this.config.system.mode;
    if (mode === 'observe-only' || mode === 'maintenance') {
      this.logger.debug({ component: 'BettingCoordinator', mode }, 'No live placement in this mode');
      return;
    }

    // Advance through entry checks
    this.machine.send({ type: 'ENTRY_CHECKS_PASSED' });

    // Multi-tenant plan quota (no-op when TENANT_ID unset)
    const quota = await checkTenantQuota();
    if (!quota.allowed) {
      this.logger.warn(
        { component: 'BettingCoordinator', roundId, reason: quota.reason },
        'Tenant quota denied'
      );
      this.machine.send({
        type: 'BET_PLACEMENT_FAILED',
        reason: quota.reason ?? 'tenant_quota_denied',
      });
      return;
    }

    if (!this.liveBetExecutor) {
      this.logger.info(
        { component: 'BettingCoordinator', roundId },
        'Approved but no LiveBetExecutor bound (dry path / missing wiring)'
      );
      return;
    }

    const betId = randomUUID();
    const stake =
      (this.config as { betting?: { stakePerEntry?: number } }).betting?.stakePerEntry ?? 700;
    const target =
      (this.config as { betting?: { cashOutTarget?: number } }).betting?.cashOutTarget ?? 1.3;
    const sessionId = this.sessionId ?? 'unknown';
    const tz =
      (this.config.betting as { dayBoundaryTimezone?: string } | undefined)?.dayBoundaryTimezone ??
      'UTC';
    const dailyKey = getDailyKey(new Date(), tz);
    let reserved = false;

    // Atomic 100/day: RESERVE before browser placement
    if (this.dailyLedger && mode === 'live') {
      const reservation = await this.dailyLedger.reserve(dailyKey, betId, sessionId);
      if (!reservation.success) {
        this.logger.warn(
          {
            component: 'BettingCoordinator',
            roundId,
            message: reservation.message,
            confirmed: reservation.confirmedCount,
            reservedCount: reservation.reservedCount,
          },
          'Daily entry reservation rejected — hard limit'
        );
        this.machine.send({
          type: 'BET_PLACEMENT_FAILED',
          reason: reservation.message ?? 'daily_limit_reservation_failed',
        });
        return;
      }
      reserved = true;
    }

    this.machine.send({ type: 'BET_SUBMITTED', betId });

    try {
      const result = await this.liveBetExecutor.placeLiveBet({
        betId,
        roundId,
        sessionId,
        stake,
        target,
        idempotencyKey: `${roundId}:${betId}`,
        dryRun: mode === 'dry-run',
      });

      if (result.placed) {
        if (this.dailyLedger && reserved) {
          await this.dailyLedger.confirm(dailyKey, betId);
        }
        this.machine.send({ type: 'BET_CONFIRMED', betId });
        this.onEntryConfirmed?.();
        await recordTenantEntry();

        // Mark prediction as executed
        if (this.lastPredictionId) {
          this.entryDecisionService.resolveActualOutcomeAsync({
            predictionId: this.lastPredictionId,
            roundId,
            actualCrashPoint: 0,
            targetThreshold: target,
            betExecuted: true,
          });
        }
      } else {
        if (this.dailyLedger && reserved) {
          await this.dailyLedger.release(
            dailyKey,
            betId,
            result.error ?? 'placement failed'
          );
        }
        this.machine.send({
          type: 'BET_PLACEMENT_FAILED',
          reason: result.error ?? 'placement failed',
        });
      }
    } catch (err) {
      if (this.dailyLedger && reserved) {
        try {
          await this.dailyLedger.release(
            dailyKey,
            betId,
            err instanceof Error ? err.message : String(err)
          );
        } catch (releaseErr) {
          this.logger.error(
            { component: 'BettingCoordinator', betId, error: String(releaseErr) },
            'Failed to release daily entry reservation'
          );
        }
      }
      this.machine.send({
        type: 'BET_PLACEMENT_FAILED',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getLastPredictionId(): string | null {
    return this.lastPredictionId;
  }
}
