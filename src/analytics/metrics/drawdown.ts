/**
 * Drawdown Metrics — Peak-to-Trough Equity Curve Analysis
 *
 * Computes maximum drawdown, current drawdown, underwater duration,
 * and drawdown severity from an equity curve derived from P&L entries.
 *
 * Drawdown is calculated from the equity curve (peak-to-trough),
 * NOT just current vs starting balance. This is the standard
 * financial definition of drawdown.
 */

import { DrawdownMetrics, DrawdownPoint, BetOutcomeRecord } from '../types';
import { classifyDrawdownSeverity } from '../constants';

/**
 * Build an equity curve from a series of bet outcomes.
 * Only win/loss outcomes affect equity; failed/unknown bets do not.
 *
 * @param outcomes — array of bet outcome records
 * @param startingEquity — initial equity (default 0)
 * @returns array of DrawdownPoint representing the equity curve
 */
export function buildEquityCurve(
  outcomes: BetOutcomeRecord[],
  startingEquity: number = 0
): DrawdownPoint[] {
  const curve: DrawdownPoint[] = [];
  let equity = startingEquity;
  let peakEquity = startingEquity;
  let underwaterDuration = 0;

  for (const outcome of outcomes) {
    // Only win/loss outcomes change equity
    if (outcome.outcome === 'win' || outcome.outcome === 'loss') {
      equity += outcome.pnl;
    }

    // Update peak
    if (equity > peakEquity) {
      peakEquity = equity;
      underwaterDuration = 0;
    }

    // Track underwater duration
    const isUnderwater = equity < peakEquity;
    if (isUnderwater) {
      underwaterDuration++;
    }

    const drawdown = peakEquity - equity;

    curve.push({
      timestamp: outcome.timestamp,
      equity,
      peakEquity,
      drawdown,
      isUnderwater,
      durationUnderwater: underwaterDuration,
    });
  }

  return curve;
}

/**
 * Compute drawdown metrics from an equity curve.
 *
 * @param curve — equity curve built from buildEquityCurve
 * @returns DrawdownMetrics with max drawdown, current drawdown, underwater stats
 */
export function computeDrawdownMetrics(curve: DrawdownPoint[]): DrawdownMetrics {
  if (curve.length === 0) {
    return {
      maxDrawdown: 0,
      currentDrawdown: 0,
      peakEquity: 0,
      currentEquity: 0,
      underwaterDuration: 0,
      maxUnderwaterDuration: 0,
      recoveryCount: 0,
      isUnderwater: false,
      drawdownSeverity: 'none',
    };
  }

  let maxDrawdown = 0;
  let maxUnderwaterDuration = 0;
  let recoveryCount = 0;
  let wasUnderwater = false;

  for (const point of curve) {
    maxDrawdown = Math.max(maxDrawdown, point.drawdown);
    maxUnderwaterDuration = Math.max(maxUnderwaterDuration, point.durationUnderwater);

    // Count recoveries (transition from underwater to new peak)
    if (wasUnderwater && !point.isUnderwater) {
      recoveryCount++;
    }
    wasUnderwater = point.isUnderwater;
  }

  const lastPoint = curve[curve.length - 1];
  const isUnderwater = lastPoint.isUnderwater;
  const currentDrawdown = lastPoint.drawdown;
  const currentEquity = lastPoint.equity;
  const peakEquity = lastPoint.peakEquity;
  const underwaterDuration = lastPoint.durationUnderwater;

  return {
    maxDrawdown,
    currentDrawdown,
    peakEquity,
    currentEquity,
    underwaterDuration,
    maxUnderwaterDuration,
    recoveryCount,
    isUnderwater,
    drawdownSeverity: classifyDrawdownSeverity(maxDrawdown),
  };
}

/**
 * Compute drawdown metrics directly from bet outcomes.
 * Convenience wrapper that builds the curve and computes metrics.
 *
 * @param outcomes — array of bet outcome records
 * @param startingEquity — initial equity (default 0)
 * @returns DrawdownMetrics
 */
export function computeDrawdownFromOutcomes(
  outcomes: BetOutcomeRecord[],
  startingEquity: number = 0
): DrawdownMetrics {
  const curve = buildEquityCurve(outcomes, startingEquity);
  return computeDrawdownMetrics(curve);
}

/**
 * Compute drawdown from an array of P&L values directly.
 * Useful for quick calculations without full BetOutcomeRecord objects.
 *
 * @param pnlValues — array of P&L values per bet
 * @param startingEquity — initial equity (default 0)
 * @returns DrawdownMetrics
 */
export function computeDrawdownFromPnl(
  pnlValues: number[],
  startingEquity: number = 0
): DrawdownMetrics {
  const outcomes: BetOutcomeRecord[] = pnlValues.map((pnl, i) => ({
    betId: `bet-${i}`,
    roundId: `round-${i}`,
    dailyKey: 'aggregate',
    timestamp: new Date().toISOString(),
    outcome: pnl >= 0 ? 'win' : 'loss',
    pnl,
    stake: 700,
    target: 1.30,
    cashOutMultiplier: null,
    latencyMs: null,
    cashOutSuccess: null,
    failureReason: null,
  }));

  return computeDrawdownFromOutcomes(outcomes, startingEquity);
}

/**
 * Find the drawdown recovery time — how many bets until equity
 * returned to the previous peak after a max drawdown event.
 *
 * @param curve — equity curve
 * @returns number of bets to recover, or null if still underwater
 */
export function findRecoveryTime(curve: DrawdownPoint[]): number | null {
  if (curve.length === 0) return null;

  let maxDdIndex = 0;
  let maxDd = 0;

  for (let i = 0; i < curve.length; i++) {
    if (curve[i].drawdown > maxDd) {
      maxDd = curve[i].drawdown;
      maxDdIndex = i;
    }
  }

  if (maxDd === 0) return 0; // Never had a drawdown

  const peakAtMaxDd = curve[maxDdIndex].peakEquity;

  for (let i = maxDdIndex + 1; i < curve.length; i++) {
    if (curve[i].equity >= peakAtMaxDd) {
      return i - maxDdIndex;
    }
  }

  return null; // Still underwater
}

/**
 * Compute consecutive drawdowns — a sequence of bets where each
 * bet results in a lower equity than the previous peak.
 *
 * @param curve — equity curve
 * @returns array of { startIndex, endIndex, depth, duration }
 */
export function findConsecutiveDrawdowns(
  curve: DrawdownPoint[]
): { startIndex: number; endIndex: number; depth: number; duration: number }[] {
  const drawdowns: { startIndex: number; endIndex: number; depth: number; duration: number }[] = [];

  let inDrawdown = false;
  let startIndex = 0;
  let maxDepth = 0;

  for (let i = 0; i < curve.length; i++) {
    const point = curve[i];

    if (point.isUnderwater && !inDrawdown) {
      inDrawdown = true;
      startIndex = i;
      maxDepth = point.drawdown;
    } else if (point.isUnderwater && inDrawdown) {
      maxDepth = Math.max(maxDepth, point.drawdown);
    } else if (!point.isUnderwater && inDrawdown) {
      drawdowns.push({
        startIndex,
        endIndex: i - 1,
        depth: maxDepth,
        duration: i - startIndex,
      });
      inDrawdown = false;
      maxDepth = 0;
    }
  }

  // Handle case where still in drawdown at end
  if (inDrawdown) {
    drawdowns.push({
      startIndex,
      endIndex: curve.length - 1,
      depth: maxDepth,
      duration: curve.length - startIndex,
    });
  }

  return drawdowns;
}

/**
 * Format drawdown metrics for human-readable display.
 */
export function formatDrawdownMetrics(metrics: DrawdownMetrics): string {
  const lines = [
    `Max Drawdown:      ${metrics.maxDrawdown.toFixed(2)}`,
    `Current Drawdown:  ${metrics.currentDrawdown.toFixed(2)}`,
    `Peak Equity:       ${metrics.peakEquity.toFixed(2)}`,
    `Current Equity:    ${metrics.currentEquity.toFixed(2)}`,
    `Underwater:        ${metrics.isUnderwater ? 'Yes' : 'No'}`,
    `Underwater Bets:   ${metrics.underwaterDuration}`,
    `Max Underwater:    ${metrics.maxUnderwaterDuration} bets`,
    `Recoveries:        ${metrics.recoveryCount}`,
    `Severity:          ${metrics.drawdownSeverity}`,
  ];

  return lines.join('\n');
}
