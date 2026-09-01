import { getLogger } from '../observability/logger';
import { globalFinancialCircuitBreaker } from '../core/circuit-breaker/financial-circuit-breaker.js';
import {
  RiskEvaluationInput,
  RiskEvaluationResult,
  RiskConditionResults,
} from './types';

/**
 * RiskEngine is the "Gatekeeper" of the betting system.
 *
 * It evaluates ALL entry conditions before approving a bet.
 * If ANY single condition fails, the bet is rejected with a clear reason.
 *
 * The engine is pure and deterministic: given the same input, it always
 * produces the same output. It has no side effects.
 *
 * Design principles:
 * - Fail-safe: if uncertain, reject.
 * - Transparent: every condition is evaluated and reported.
 * - Fast: all checks are synchronous — no I/O.
 */
export class RiskEngine {
  private readonly logger = getLogger();

  /**
   * Evaluate all entry conditions and return a comprehensive result.
   *
   * This is the single source of truth for whether a bet may be placed.
   * The state machine independently verifies its own guards, but the
   * RiskEngine's approval is the authoritative business-level decision.
   */
  evaluate(input: RiskEvaluationInput): RiskEvaluationResult {
    const circuit = globalFinancialCircuitBreaker.snapshot();
    if (circuit.state === 'OPEN') {
      const conditions = this.evaluateAllConditions(input);
      return {
        approved: false,
        conditions,
        rejectionReason: 'Financial circuit breaker is OPEN — entries suspended',
        firstFailure: 'financial_circuit_open',
      };
    }

    const conditions = this.evaluateAllConditions(input);
    const failures = this.collectFailures(conditions);

    if (failures.length === 0) {
      this.logger.debug(
        {
          component: 'RiskEngine',
          sessionId: input.roundState?.roundId,
          mode: input.mode,
          balance: input.currentBalance,
          dailyEntries: input.dailyEntriesConfirmed,
        },
        'Risk evaluation: APPROVED'
      );

      return {
        approved: true,
        conditions,
        rejectionReason: null,
        firstFailure: null,
      };
    }

    const firstFailure = failures[0];
    const rejectionReason = this.buildRejectionMessage(failures);

    this.logger.warn(
      {
        component: 'RiskEngine',
        sessionId: input.roundState?.roundId,
        firstFailure,
        rejectionReason,
        mode: input.mode,
        balance: input.currentBalance,
        dailyEntries: input.dailyEntriesConfirmed,
      },
      `Risk evaluation: REJECTED — ${firstFailure}`
    );

    return {
      approved: false,
      conditions,
      rejectionReason,
      firstFailure,
    };
  }

  /**
   * Quick-check version that returns only approved/rejected.
   * Use when you don't need the detailed breakdown.
   */
  isApproved(input: RiskEvaluationInput): boolean {
    return this.evaluate(input).approved;
  }

  // ─── Private Evaluation ────────────────────────────────────────────────────

  private evaluateAllConditions(input: RiskEvaluationInput): RiskConditionResults {
    const roundPhase = input.roundState?.phase ?? 'unknown';
    const confidence = input.roundState?.confidence ?? 'low';
    const balance = input.currentBalance ?? 0;
    const required = input.requiredStake + input.balanceBuffer;

    const isDryRun = input.mode === 'dry-run';
    return {
      modeIsLive: input.mode === 'live' || isDryRun,
      operatorAuthorized: input.operatorAuthorized,
      // Dry-run: authentication is NOT required (virtual trades only)
      sessionAuthenticated: isDryRun ? true : input.sessionAuthenticated,
      gameLoaded: input.gameLoaded,
      roundStateValid:
        input.roundState !== null &&
        (roundPhase === 'starting' || roundPhase === 'running') &&
        input.roundState.roundId !== null,
      // Dry-run: virtual bankroll — treat null/positive simulated balance as sufficient
      balanceSufficient: isDryRun
        ? (input.currentBalance === null || balance >= required)
        : input.currentBalance !== null && balance >= required,
      dailyEntriesBelowLimit: input.dailyEntriesConfirmed < input.maxDailyEntries,
      notPaused: !input.paused,
      killSwitchOff: !input.killSwitch,
      browserHealthy: input.browserHealthy,
      gameAdapterHealthy: input.gameAdapterHealthy,
      observationConfidenceHigh: confidence === 'high',
      noOpenBet: !input.openBetExists,
      cooldownElapsed: input.cooldownElapsed,
      errorThresholdOk: input.consecutiveErrors < input.maxConsecutiveErrors,
      cashOutFailureThresholdOk: input.cashOutFailures < input.maxCashOutFailures,
      predictionAcceptable: this.evaluatePrediction(input),
    };
  }

  private evaluatePrediction(input: RiskEvaluationInput): boolean {
    const minProb = input.minPredictionProbability ?? 0;
    const minConf = input.minPredictionConfidence ?? 0;
    if (minProb <= 0 && minConf <= 0) return true;
    const signal = input.predictionSignal;
    if (!signal) return false;
    if (new Date(signal.expiresAt).getTime() <= Date.now()) return false;
    if (signal.probability < minProb) return false;
    if (signal.confidence < minConf) return false;
    if (signal.dataQuality < 0.3) return false;
    return true;
  }

  private collectFailures(conditions: RiskConditionResults): string[] {
    const failures: string[] = [];
    const checks: [keyof RiskConditionResults, string][] = [
      ['modeIsLive', 'System mode is not live or dry-run'],
      ['operatorAuthorized', 'Operator not authorized'],
      ['sessionAuthenticated', 'Session not authenticated'],
      ['gameLoaded', 'Game not loaded'],
      ['roundStateValid', 'Round state invalid — no active round or wrong phase'],
      ['balanceSufficient', 'Insufficient balance for stake plus buffer'],
      ['dailyEntriesBelowLimit', 'Daily entry limit reached'],
      ['notPaused', 'System is paused'],
      ['killSwitchOff', 'Kill switch is engaged'],
      ['browserHealthy', 'Browser health check failed'],
      ['gameAdapterHealthy', 'Game adapter health check failed'],
      ['observationConfidenceHigh', 'Observation confidence is not high'],
      ['noOpenBet', 'An open bet already exists'],
      ['cooldownElapsed', 'Cooldown period has not elapsed'],
      ['errorThresholdOk', 'Consecutive error threshold exceeded'],
      ['cashOutFailureThresholdOk', 'Cash-out failure threshold exceeded'],
      ['predictionAcceptable', 'Prediction signal missing, expired, or below thresholds'],
    ];

    for (const [key, message] of checks) {
      if (!conditions[key]) {
        failures.push(message);
      }
    }

    return failures;
  }

  private buildRejectionMessage(failures: string[]): string {
    if (failures.length === 1) {
      return `Entry rejected: ${failures[0]}`;
    }
    return `Entry rejected (${failures.length} failures): ${failures.join('; ')}`;
  }

  /**
   * Determine if betting should pause after a streak of consecutive losses.
   */
  shouldPauseAfterStreak(dailyStats: { consecutiveLosses?: number; losses?: number } | null): boolean {
    if (!dailyStats) return false;
    const threshold = 10;
    return (dailyStats.consecutiveLosses ?? 0) >= threshold || (dailyStats.losses ?? 0) >= threshold;
  }
}

/**
 * Singleton instance for convenience.
 */
let globalRiskEngine: RiskEngine | null = null;

/** @deprecated Prefer `new RiskEngine()` injected from composition */
export function getRiskEngine(): RiskEngine {
  if (!globalRiskEngine) {
    globalRiskEngine = new RiskEngine();
  }
  return globalRiskEngine;
}

export function setRiskEngine(engine: RiskEngine): void {
  globalRiskEngine = engine;
}
