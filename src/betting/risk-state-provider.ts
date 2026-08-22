/**
 * RiskStateProvider — builds RiskEvaluationInput from real system state.
 * Never hardcodes health/ledger/pause values for the live path.
 */

import { AppConfig } from '../config/schema.js';
import { RiskEvaluationInput } from './types.js';
import { BalanceTracker } from '../ledger/balance-tracker.js';
import { DailyEntryLedger, DailyEntryCounter } from '../ledger/daily-entries.js';
import { BettingStateMachine } from '../core/state-machine/machine.js';
import { getDailyKey } from '../utils/day-boundary.js';
import { RoundState } from '../types/game.js';
import { getLogger } from '../observability/logger.js';

export interface RiskStateSnapshot {
  browserHealthy: boolean;
  gameAdapterHealthy: boolean;
  paused: boolean;
  killSwitch: boolean;
  openBetExists: boolean;
  cooldownElapsed: boolean;
  consecutiveErrors: number;
  cashOutFailures: number;
  sessionAuthenticated: boolean;
  gameLoaded: boolean;
  operatorAuthorized: boolean;
}

export type RiskStateSource = () => Partial<RiskStateSnapshot>;

export interface RiskStateProviderOptions {
  config: AppConfig;
  balanceTracker: BalanceTracker;
  /** Preferred: durable ledger */
  dailyLedger?: DailyEntryLedger | null;
  /** Fallback in-process counter */
  dailyCounter?: DailyEntryCounter | null;
  /** Optional state machine for open bet / pause / cooldown */
  getStateMachine?: () => BettingStateMachine | null;
  /** Live system health/auth/error signals */
  getLiveState?: RiskStateSource;
}

export class RiskStateProvider {
  private readonly logger = getLogger();
  private readonly config: AppConfig;
  private readonly balanceTracker: BalanceTracker;
  private readonly dailyLedger: DailyEntryLedger | null;
  private readonly dailyCounter: DailyEntryCounter | null;
  private readonly getStateMachine?: () => BettingStateMachine | null;
  private readonly getLiveState?: RiskStateSource;

  /** Cached last known confirmed count (updated async) */
  private lastConfirmedEntries = 0;

  constructor(options: RiskStateProviderOptions) {
    this.config = options.config;
    this.balanceTracker = options.balanceTracker;
    this.dailyLedger = options.dailyLedger ?? null;
    this.dailyCounter = options.dailyCounter ?? null;
    this.getStateMachine = options.getStateMachine;
    this.getLiveState = options.getLiveState;
  }

  /**
   * Refresh daily entry count from ledger (call periodically or before entry).
   */
  async refreshDailyEntries(): Promise<number> {
    const tz =
      (this.config.betting as { dayBoundaryTimezone?: string } | undefined)?.dayBoundaryTimezone ??
      'UTC';
    const dailyKey = getDailyKey(new Date(), tz);
    if (this.dailyLedger) {
      try {
        const confirmed = await this.dailyLedger.getConfirmedCount(dailyKey);
        const reserved = await this.dailyLedger.getReservedCount(dailyKey);
        // Count reserved toward limit (same semantics as ledger.reserve)
        this.lastConfirmedEntries = confirmed + reserved;
        return this.lastConfirmedEntries;
      } catch (err) {
        this.logger.warn(
          { component: 'RiskStateProvider', error: String(err) },
          'Ledger read failed — using counter fallback'
        );
      }
    }

    if (this.dailyCounter) {
      this.lastConfirmedEntries = this.dailyCounter.getCount();
      return this.lastConfirmedEntries;
    }

    return this.lastConfirmedEntries;
  }

  /**
   * Synchronous build using last refreshed ledger count + live state sources.
   */
  build(roundState?: RoundState | null): RiskEvaluationInput {
    const live = this.getLiveState?.() ?? {};
    const sm = this.getStateMachine?.() ?? null;
    const ctx = sm?.getContext();

    const mode = this.config.system.mode as RiskEvaluationInput['mode'];
    const isLive = mode === 'live';
    const maxDaily =
      (this.config.betting as { maxDailyEntries?: number } | undefined)?.maxDailyEntries ?? 100;
    const stake =
      (this.config.betting as { stakePerEntry?: number } | undefined)?.stakePerEntry ?? 700;
    const riskCfg = this.config.risk ?? ({} as AppConfig['risk']);

    // Fail-closed in live: unknown safety state ⇒ unsafe
    // Fail-open defaults only for non-live (observe/dry-run/tests)
    const defSafe = !isLive;

    // Prefer state machine context when present
    const openBetExists = ctx?.openBetExists ?? live.openBetExists ?? false;
    const paused = ctx?.paused ?? live.paused ?? false;
    const killSwitch = ctx?.killSwitch ?? live.killSwitch ?? false;
    const consecutiveErrors = ctx?.consecutiveErrors ?? live.consecutiveErrors ?? 0;
    const cashOutFailures = ctx?.cashOutFailures ?? live.cashOutFailures ?? 0;

    let cooldownElapsed = live.cooldownElapsed;
    if (cooldownElapsed === undefined) {
      if (ctx?.lastBetAt && (ctx.cooldownMs ?? 0) > 0) {
        const elapsed = Date.now() - new Date(ctx.lastBetAt).getTime();
        cooldownElapsed = elapsed >= ctx.cooldownMs;
      } else {
        cooldownElapsed = defSafe; // live: unknown cooldown ⇒ not elapsed
      }
    }

    const browserHealthy = live.browserHealthy ?? defSafe;
    const gameAdapterHealthy = live.gameAdapterHealthy ?? defSafe;

    // Daily entries: counter is authoritative fallback; ledger refreshed async
    let dailyEntries = this.lastConfirmedEntries;
    if (this.dailyCounter) {
      dailyEntries = Math.max(dailyEntries, this.dailyCounter.getCount());
    }

    return {
      mode,
      operatorAuthorized: live.operatorAuthorized ?? defSafe,
      sessionAuthenticated: live.sessionAuthenticated ?? defSafe,
      gameLoaded: live.gameLoaded ?? defSafe,
      roundState: roundState ?? ctx?.roundState ?? null,
      currentBalance: this.balanceTracker.getCurrentBalance(),
      dailyEntriesConfirmed: dailyEntries,
      paused,
      killSwitch,
      browserHealthy,
      gameAdapterHealthy,
      openBetExists,
      cooldownElapsed,
      requiredStake: stake,
      balanceBuffer: riskCfg.balanceBuffer ?? 0,
      maxDailyEntries: maxDaily,
      minConfidenceForEntry:
        this.config.observation?.minConfidenceForEntry ?? 'high',
      consecutiveErrors,
      maxConsecutiveErrors: riskCfg.maxConsecutiveErrorsBeforeStop ?? 3,
      cashOutFailures,
      maxCashOutFailures: riskCfg.maxCashOutFailuresBeforeStop ?? 2,
      minPredictionProbability: riskCfg.minPredictionProbability ?? 0.35,
      minPredictionConfidence: riskCfg.minPredictionConfidence ?? 0.3,
    };
  }

  /**
   * Preferred entry path: refresh ledger then build.
   */
  async buildFresh(roundState?: RoundState | null): Promise<RiskEvaluationInput> {
    await this.refreshDailyEntries();
    return this.build(roundState);
  }

  getLastConfirmedEntries(): number {
    return this.lastConfirmedEntries;
  }
}
