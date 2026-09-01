/**
 * Strategy Layer — converts ACIE decision state into ENTRY / SKIP / REDUCED_ENTRY.
 *
 * High-frequency (HF) adaptive mode targets up to ~500 quality entries/day
 * without hard-blocking on mild evidence degradation.
 */

import {
  StrategyDecision,
  StrategyDecisionContext,
  StrategyPolicy,
  StrategyPolicyMode,
} from './types.js';

/** Classic conservative defaults (lower entry rate). */
export const DEFAULT_STRATEGY_POLICY: StrategyPolicy = {
  mode: 'adaptive',
  supportedThreshold: 0.62,
  weakThreshold: 0.66,
  fallbackThreshold: 0.6,
  maxCalibrationError: 0.14,
  highUncertainty: 0.22,
  consecutiveLossReduceAt: 4,
  reducedStakeFactor: 0.5,
  defaultStake: 700,
};

/**
 * Tuned for ≥500 selective entries/day at 1.30× cash-out.
 * Slightly lower bars, stronger mean-reversion bias after low streaks,
 * softer consecutive-loss handling so the engine keeps evaluating.
 */
export const HIGH_FREQUENCY_STRATEGY_POLICY: StrategyPolicy = {
  mode: 'adaptive',
  supportedThreshold: 0.58,
  weakThreshold: 0.62,
  fallbackThreshold: 0.57,
  maxCalibrationError: 0.16,
  highUncertainty: 0.25,
  consecutiveLossReduceAt: 5,
  reducedStakeFactor: 0.6,
  defaultStake: 700,
};

export class StrategyLayer {
  constructor(private readonly policy: StrategyPolicy = HIGH_FREQUENCY_STRATEGY_POLICY) {}

  evaluate(ctx: StrategyDecisionContext): StrategyDecision {
    const { probability, evidence, calibrationError, uncertainty, riskState, regime } = ctx;
    const p = this.policy;

    // Extreme calibration failure — skip only in strict mode
    if (calibrationError > p.maxCalibrationError && evidence === 'DEGRADED') {
      if (p.mode === 'strict') {
        return this.skip(
          `PSI degraded and poorly calibrated (error ${(calibrationError * 100).toFixed(1)}%).`
        );
      }
    }

    if (p.mode === 'strict') {
      if (evidence === 'DEGRADED' || evidence === 'INSUFFICIENT') {
        return this.skip(`Strict policy: evidence=${evidence}. No entry.`);
      }
    }

    let effectiveProb = probability;
    let threshold = p.supportedThreshold;
    let usingFallback = false;

    if (evidence === 'SUPPORTED') {
      threshold = p.supportedThreshold;
    } else if (evidence === 'WEAK') {
      threshold = p.weakThreshold;
    } else if (p.mode === 'frequency_fallback') {
      effectiveProb = ctx.baselineProbability;
      threshold = p.fallbackThreshold;
      usingFallback = true;
    } else if (p.mode === 'adaptive') {
      effectiveProb = probability;
      threshold = Math.max(p.weakThreshold - 0.02, p.fallbackThreshold);
    } else {
      return this.skip(`Evidence ${evidence} under strict/unsupported policy.`);
    }

    // Regime-adaptive threshold adjustments (boost entry rate after low streaks)
    threshold = this.regimeAdjustedThreshold(threshold, regime, ctx);

    // Soft daily pacing: when approaching limit, raise bar slightly to keep best entries
    const used = riskState.dailyEntriesUsed ?? 0;
    const limit = riskState.dailyEntriesLimit ?? 500;
    if (limit > 0 && used / limit > 0.85) {
      threshold += 0.03;
    } else if (limit > 0 && used / limit < 0.25 && used < limit * 0.25) {
      // Early day: slightly lower bar to build volume with still-selective signals
      threshold -= 0.015;
    }

    if (uncertainty.total > p.highUncertainty && evidence !== 'SUPPORTED') {
      if (effectiveProb >= threshold) {
        return {
          action: 'REDUCED_ENTRY',
          stake: this.reducedStake(riskState),
          reason: `High uncertainty (${(uncertainty.total * 100).toFixed(1)}%). Reduced stake.`,
          confidence: Math.max(0, 1 - uncertainty.total),
          isOpportunity: true,
        };
      }
    }

    if (effectiveProb < threshold) {
      return this.skip(
        `Probability ${(effectiveProb * 100).toFixed(1)}% below threshold ${(threshold * 100).toFixed(0)}%` +
          (usingFallback ? ' (frequency fallback).' : '.')
      );
    }

    if (riskState.consecutiveLosses >= p.consecutiveLossReduceAt) {
      return {
        action: 'REDUCED_ENTRY',
        stake: this.reducedStake(riskState),
        reason: `${riskState.consecutiveLosses} consecutive losses — reduced stake.`,
        confidence: effectiveProb,
        isOpportunity: true,
      };
    }

    return {
      action: 'ENTRY',
      stake: p.defaultStake,
      reason:
        `P=${(effectiveProb * 100).toFixed(1)}% ≥ ${(threshold * 100).toFixed(0)}%` +
        ` | evidence=${evidence}` +
        (usingFallback ? ' | frequency_fallback' : '') +
        ` | regime=${regime} policy ok.`,
      confidence: effectiveProb,
      isOpportunity: true,
    };
  }

  withPolicy(partial: Partial<StrategyPolicy> & { mode?: StrategyPolicyMode }): StrategyLayer {
    return new StrategyLayer({ ...this.policy, ...partial });
  }

  getPolicy(): StrategyPolicy {
    return this.policy;
  }

  private regimeAdjustedThreshold(
    base: number,
    regime: StrategyDecisionContext['regime'],
    ctx: StrategyDecisionContext
  ): number {
    let t = base;
    if (regime === 'deep-low' || regime === 'low-cluster') {
      t -= 0.025; // mean-reversion window — more entries
    } else if (regime === 'volatile') {
      t += 0.02; // require stronger edge
    } else if (regime === 'high-activity') {
      t -= 0.01;
    }
    // If ensemble CI lower bound is already above ~0.55, relax slightly
    const lo = ctx.confidenceInterval?.[0];
    if (typeof lo === 'number' && lo >= 0.55) {
      t -= 0.01;
    }
    return Math.max(0.52, Math.min(0.75, t));
  }

  private reducedStake(_risk: StrategyDecisionContext['riskState']): number {
    return Math.max(1, Math.round(this.policy.defaultStake * this.policy.reducedStakeFactor));
  }

  private skip(reason: string): StrategyDecision {
    return {
      action: 'SKIP',
      stake: 0,
      reason,
      confidence: 0,
      isOpportunity: false,
    };
  }
}
