import { StateMachineContext, StateMachineEvent, GuardResult } from './types';
import { ObservationConfidence } from '../../types/game';

/**
 * Guards are pure functions that evaluate whether a state transition
 * is permitted given the current context and event.
 *
 * All guards follow the fail-safe principle: if uncertain, reject.
 * Every rejection includes a clear, actionable reason string.
 */

// ─── Health Guards ───────────────────────────────────────────────────────────

/**
 * Reject transitions that require a healthy browser if the browser is unhealthy.
 */
export function guardBrowserHealthy(ctx: StateMachineContext): GuardResult {
  if (!ctx.browserHealthy) {
    return { permitted: false, reason: 'Browser health check failed — betting suspended until browser recovers' };
  }
  return { permitted: true };
}

/**
 * Reject transitions that require a healthy game adapter if the adapter is unhealthy.
 */
export function guardGameAdapterHealthy(ctx: StateMachineContext): GuardResult {
  if (!ctx.gameAdapterHealthy) {
    return { permitted: false, reason: 'Game adapter health check failed — observation data unreliable' };
  }
  return { permitted: true };
}

/**
 * Reject if observation confidence is below the configured threshold.
 */
export function guardObservationConfidence(
  ctx: StateMachineContext,
  required: ObservationConfidence = ctx.minConfidenceForEntry
): GuardResult {
  const confidence = ctx.roundState?.confidence ?? 'low';
  const levels: Record<ObservationConfidence, number> = { low: 1, medium: 2, high: 3 };

  if (levels[confidence] < levels[required]) {
    return {
      permitted: false,
      reason: `Observation confidence is ${confidence}, but ${required} is required — round data too uncertain for betting`,
    };
  }
  return { permitted: true };
}

// ─── Operational Guards ──────────────────────────────────────────────────────

/**
 * Reject if the system is paused.
 */
export function guardNotPaused(ctx: StateMachineContext): GuardResult {
  if (ctx.paused) {
    return { permitted: false, reason: 'System is paused — resume before placing bets' };
  }
  return { permitted: true };
}

/**
 * Reject if the kill switch is engaged.
 */
export function guardKillSwitchOff(ctx: StateMachineContext): GuardResult {
  if (ctx.killSwitch) {
    return { permitted: false, reason: 'Kill switch is engaged — manual operator intervention required' };
  }
  return { permitted: true };
}

/**
 * Reject if there is already an open bet (prevents duplicate bets).
 */
export function guardNoOpenBet(ctx: StateMachineContext): GuardResult {
  if (ctx.openBetExists) {
    return { permitted: false, reason: 'An open bet already exists — cannot place another until current bet resolves' };
  }
  return { permitted: true };
}

/**
 * Reject if the cooldown period has not elapsed since the last bet.
 */
export function guardCooldownElapsed(ctx: StateMachineContext): GuardResult {
  if (!ctx.lastBetAt) {
    return { permitted: true };
  }
  const elapsed = Date.now() - new Date(ctx.lastBetAt).getTime();
  if (elapsed < ctx.cooldownMs) {
    return {
      permitted: false,
      reason: `Cooldown active — ${Math.ceil((ctx.cooldownMs - elapsed) / 1000)}s remaining before next entry`,
    };
  }
  return { permitted: true };
}

// ─── Round State Guards ──────────────────────────────────────────────────────

/**
 * Reject if there is no valid round to bet on.
 */
export function guardRoundValid(ctx: StateMachineContext, eventRoundId?: string): GuardResult {
  if (!ctx.roundState) {
    return { permitted: false, reason: 'No round state available — observer not initialized or round not detected' };
  }
  if (!ctx.currentRoundId && !eventRoundId) {
    return { permitted: false, reason: 'Round ID is missing — cannot associate bet with a specific round' };
  }
  if (ctx.roundState.phase !== 'starting' && ctx.roundState.phase !== 'running') {
    return {
      permitted: false,
      reason: `Round phase is ${ctx.roundState.phase}, but must be starting or running to place a bet`,
    };
  }
  return { permitted: true };
}

// ─── Balance & Limit Guards ──────────────────────────────────────────────────

/**
 * Reject if balance is insufficient for the required stake plus buffer.
 * Note: The actual balance check with configured stake/buffer is performed
 * by the RiskEngine; this guard ensures a balance value is present.
 */
export function guardBalanceKnown(ctx: StateMachineContext): GuardResult {
  if (ctx.currentBalance === null || ctx.currentBalance === undefined) {
    return { permitted: false, reason: 'Current balance is unknown — cannot verify sufficient funds' };
  }
  return { permitted: true };
}

// ─── Error Threshold Guards ──────────────────────────────────────────────────

/**
 * Reject if too many consecutive errors have occurred.
 */
export function guardErrorThreshold(ctx: StateMachineContext): GuardResult {
  if (ctx.consecutiveErrors >= ctx.maxConsecutiveErrors) {
    return {
      permitted: false,
      reason: `Consecutive error threshold exceeded (${ctx.consecutiveErrors}/${ctx.maxConsecutiveErrors}) — halting to prevent cascade failure`,
    };
  }
  return { permitted: true };
}

/**
 * Reject if too many cash-out failures have occurred.
 */
export function guardCashOutFailureThreshold(ctx: StateMachineContext): GuardResult {
  if (ctx.cashOutFailures >= ctx.maxCashOutFailures) {
    return {
      permitted: false,
      reason: `Cash-out failure threshold exceeded (${ctx.cashOutFailures}/${ctx.maxCashOutFailures}) — execution path unreliable`,
    };
  }
  return { permitted: true };
}

// ─── Composite Guards ────────────────────────────────────────────────────────

/**
 * All guards that must pass for a bet to be placed.
 * Evaluated in order of dependency (health → operational → round → balance → thresholds).
 */
export function guardAllEntryConditions(
  ctx: StateMachineContext,
  event: StateMachineEvent
): GuardResult {
  const eventRoundId = event.type === 'ROUND_STARTED' ? event.roundId : undefined;

  const guards: Array<(ctx: StateMachineContext) => GuardResult> = [
    guardBrowserHealthy,
    guardGameAdapterHealthy,
    guardNotPaused,
    guardKillSwitchOff,
    guardNoOpenBet,
    guardCooldownElapsed,
    () => guardRoundValid(ctx, eventRoundId),
    guardObservationConfidence,
    guardBalanceKnown,
    guardErrorThreshold,
    guardCashOutFailureThreshold,
  ];

  for (const guard of guards) {
    const result = guard(ctx);
    if (!result.permitted) {
      return result;
    }
  }

  return { permitted: true };
}

/**
 * Guards for transitioning from OBSERVING to ENTRY_EVALUATING.
 */
export function guardCanEvaluateEntry(
  ctx: StateMachineContext,
  event: StateMachineEvent
): GuardResult {
  if (event.type !== 'ROUND_STARTED') {
    return { permitted: false, reason: 'Entry evaluation requires a ROUND_STARTED event' };
  }
  const roundResult = guardRoundValid(ctx, event.roundId);
  if (!roundResult.permitted) return roundResult;
  return guardAllEntryConditions(ctx, event);
}

/**
 * Guards for transitioning from ENTRY_EVALUATING to ENTRY_APPROVED.
 */
export function guardCanApproveEntry(
  ctx: StateMachineContext,
  event: StateMachineEvent
): GuardResult {
  if (event.type !== 'RISK_APPROVED') {
    return { permitted: false, reason: 'Entry approval requires a RISK_APPROVED event' };
  }
  // Re-evaluate all conditions — the risk engine's approval is advisory;
  // the state machine independently verifies guards haven't changed.
  return guardAllEntryConditions(ctx, event);
}

/**
 * Guards for transitioning to BET_PLACING.
 */
export function guardCanPlaceBet(
  ctx: StateMachineContext,
  event: StateMachineEvent
): GuardResult {
  if (event.type !== 'ENTRY_CHECKS_PASSED' && event.type !== 'BET_SUBMITTED') {
    return { permitted: false, reason: 'Bet placement requires ENTRY_CHECKS_PASSED or BET_SUBMITTED event' };
  }
  return guardAllEntryConditions(ctx, event);
}

/**
 * Guards for cash-out trigger.
 */
export function guardCanCashOut(
  ctx: StateMachineContext,
  event: StateMachineEvent
): GuardResult {
  if (event.type !== 'MULTIPLIER_REACHED_TARGET' && event.type !== 'CASH_OUT_TRIGGERED') {
    return { permitted: false, reason: 'Cash-out requires MULTIPLIER_REACHED_TARGET or CASH_OUT_TRIGGERED event' };
  }
  if (!ctx.openBetExists) {
    return { permitted: false, reason: 'No open bet to cash out' };
  }
  if (!ctx.currentBetId) {
    return { permitted: false, reason: 'Bet ID missing — cannot request cash-out' };
  }
  return { permitted: true };
}

/**
 * Guards for resuming from PAUSED.
 */
export function guardCanResume(ctx: StateMachineContext): GuardResult {
  if (!ctx.paused) {
    return { permitted: false, reason: 'System is not paused — no resume needed' };
  }
  if (ctx.killSwitch) {
    return { permitted: false, reason: 'Cannot resume while kill switch is engaged' };
  }
  return { permitted: true };
}

/**
 * Guards for recovery from ERROR.
 */
export function guardCanRecover(ctx: StateMachineContext): GuardResult {
  if (ctx.consecutiveErrors >= ctx.maxConsecutiveErrors) {
    return {
      permitted: false,
      reason: `Too many consecutive errors (${ctx.consecutiveErrors}) — manual reset required`,
    };
  }
  return { permitted: true };
}
