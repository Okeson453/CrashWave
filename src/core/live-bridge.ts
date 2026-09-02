/**
 * Live signal bridge — RoundStarted → EntryDecisionService (includes RiskEngine) → LiveBetExecutor.
 * Only when system mode is `live` and isRealExecutionAllowed().
 * Dry-run remains exclusively in dry-run-bridge.ts.
 */
import type { AppConfig } from '../config/schema';
import type { EntryDecisionService } from '../prediction/entry-decision-service';
import type { LiveBetExecutor } from '../betting/live-executor';
import type { LiveCashOutExecutor } from '../betting/live-cashout';
import type { RiskEvaluationInput } from '../betting/types';
import { LiveBetExecutor as LiveBetExecutorClass } from '../betting/live-executor';
import { isRealExecutionAllowed } from '../betting/execution-mode-gate';
import { getLogger } from '../observability/logger';

const logger = getLogger().child({ component: 'LiveBridge' });

const openLiveBets = new Set<string>();

export interface LiveBridgeDeps {
  config: AppConfig;
  entryDecisionService: EntryDecisionService;
  liveBetExecutor: LiveBetExecutor | null;
  liveCashOutExecutor: LiveCashOutExecutor | null;
  sessionId: string;
  isAuthenticated: () => boolean;
  isGameLoaded: () => boolean;
  isObserving: () => boolean;
  getBalance: () => number;
}

function buildRiskInput(deps: LiveBridgeDeps, roundId: string): RiskEvaluationInput {
  const stake = Number(deps.config.betting?.stakePerEntry ?? 700);
  return {
    mode: 'live',
    operatorAuthorized: true,
    sessionAuthenticated: deps.isAuthenticated(),
    gameLoaded: deps.isGameLoaded(),
    roundState: {
      phase: 'starting',
      roundId,
      currentMultiplier: 1,
      crashPoint: null,
      startedAt: new Date().toISOString(),
      lastTickAt: null,
      crashedAt: null,
      confidence: 'medium',
      source: 'dom',
    },
    currentBalance: deps.getBalance(),
    dailyEntriesConfirmed: 0,
    paused: false,
    killSwitch: false,
    browserHealthy: true,
    gameAdapterHealthy: true,
    openBetExists: deps.liveBetExecutor?.isBusy() ?? false,
    cooldownElapsed: true,
    requiredStake: stake,
    balanceBuffer: Number(deps.config.risk?.balanceBuffer ?? stake),
    maxDailyEntries: Number(deps.config.betting?.maxDailyEntries ?? 500),
    minConfidenceForEntry: 'medium',
    consecutiveErrors: 0,
    maxConsecutiveErrors: Number(deps.config.risk?.maxConsecutiveErrorsBeforeStop ?? 3),
    cashOutFailures: 0,
    maxCashOutFailures: Number(deps.config.risk?.maxCashOutFailuresBeforeStop ?? 2),
    minPredictionProbability: Number(deps.config.risk?.minPredictionProbability ?? 0.35),
    minPredictionConfidence: Number(deps.config.risk?.minPredictionConfidence ?? 0.3),
  };
}

export async function onRoundStartedForLive(
  deps: LiveBridgeDeps,
  roundId: string
): Promise<void> {
  const mode = String(deps.config.system?.mode ?? '').toLowerCase();
  if (mode !== 'live') return;
  if (!isRealExecutionAllowed(false)) {
    logger.debug('Live bridge idle — ALLOW_REAL_EXECUTION not enabled or mode gate blocked');
    return;
  }
  if (!deps.isAuthenticated() || !deps.isObserving()) {
    logger.warn({ roundId }, 'Live bridge skipped — not authenticated/observing');
    return;
  }
  if (!deps.liveBetExecutor) {
    logger.warn({ roundId }, 'Live bridge skipped — no LiveBetExecutor bound');
    return;
  }

  try {
    const target = Number(deps.config.betting?.cashOutTarget ?? 1.3) as unknown as 1.3;
    const stake = Number(deps.config.betting?.stakePerEntry ?? 700);
    const riskInput = buildRiskInput(deps, roundId);

    const decision = await deps.entryDecisionService.evaluateEntry({
      roundId,
      sessionId: deps.sessionId,
      decisionTimestamp: new Date().toISOString(),
      riskInput,
      target,
    });

    if (!decision.signal || !decision.riskResult.approved) {
      logger.info(
        {
          roundId,
          hasSignal: !!decision.signal,
          approved: decision.riskResult.approved,
          reason: decision.riskResult.rejectionReason,
        },
        'Live entry not taken'
      );
      return;
    }

    const req = LiveBetExecutorClass.buildRequest({
      roundId,
      sessionId: deps.sessionId,
      stake,
      target: Number(decision.signal.target ?? target),
    });
    const result = await deps.liveBetExecutor.placeLiveBet(req);
    if (result.placed) {
      openLiveBets.add(roundId);
      deps.liveCashOutExecutor?.setTarget(Number(decision.signal.target ?? target));
      logger.info({ roundId, betId: result.betId, latencyMs: result.latencyMs }, 'Live bet accepted');
    } else {
      logger.warn({ roundId, error: result.error }, 'Live bet placement failed');
    }
  } catch (err) {
    logger.warn({ roundId, error: String(err) }, 'Live bridge evaluation failed');
  }
}

export async function onRoundCrashedForLive(
  deps: LiveBridgeDeps,
  payload: { roundId?: string; crashPoint?: number }
): Promise<void> {
  if (String(deps.config.system?.mode ?? '').toLowerCase() !== 'live') return;
  const rid = String(payload.roundId ?? '');
  const cp = Number(payload.crashPoint ?? 0);
  if (!rid || !Number.isFinite(cp) || cp <= 0) return;
  try {
    deps.entryDecisionService.observeCrash(rid, cp);
  } catch (err) {
    logger.debug({ error: String(err) }, 'observeCrash failed');
  }
  if (openLiveBets.has(rid) && deps.liveCashOutExecutor) {
    openLiveBets.delete(rid);
    try {
      await deps.liveCashOutExecutor.cashOut(rid, rid, false);
      logger.info({ roundId: rid, crashPoint: cp }, 'Live cash-out triggered on crash');
    } catch (err) {
      logger.debug({ roundId: rid, error: String(err) }, 'Live cash-out failed');
    }
  }
}
