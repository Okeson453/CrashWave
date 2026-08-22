/**
 * Strategy Layer — converts ACIE decision state into ENTRY / SKIP / REDUCED_ENTRY.
 *
 * Critical: evidence quality informs policy; it does NOT automatically zero out
 * the product's ability to evaluate opportunities. Policy mode controls that.
 */

import {
  StrategyDecision,
  StrategyDecisionContext,
  StrategyPolicy,
  StrategyPolicyMode,
} from './types.js';

export const DEFAULT_STRATEGY_POLICY: StrategyPolicy = {
  mode: 'adaptive',
  supportedThreshold: 0.65,
  weakThreshold: 0.7,
  fallbackThreshold: 0.62,
  maxCalibrationError: 0.12,
  highUncertainty: 0.2,
  consecutiveLossReduceAt: 3,
  reducedStakeFactor: 0.5,
  defaultStake: 700,
};

export class StrategyLayer {
  constructor(private readonly policy: StrategyPolicy = DEFAULT_STRATEGY_POLICY) {}

  evaluate(ctx: StrategyDecisionContext): StrategyDecision {
    const { probability, evidence, calibrationError, uncertainty, riskState } = ctx;
    const p = this.policy;

    // Extreme calibration failure — skip regardless of mode
    if (calibrationError > p.maxCalibrationError && evidence === 'DEGRADED') {
      if (p.mode === 'strict') {
        return this.skip(
          `PSI degraded and poorly calibrated (error ${(calibrationError * 100).toFixed(1)}%).`
        );
      }
      // adaptive / frequency_fallback: fall through to baseline path
    }

    if (p.mode === 'strict') {
      if (evidence === 'DEGRADED' || evidence === 'INSUFFICIENT') {
        return this.skip(
          `Strict policy: evidence=${evidence}. ${ctx.evidence === evidence ? '' : ''}No entry.`
        );
      }
    }

    // Resolve effective probability and threshold by policy
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
      // Still score opportunity with elevated bar; do not hard-block product
      effectiveProb = probability;
      threshold = Math.max(p.weakThreshold, p.fallbackThreshold + 0.05);
    } else {
      return this.skip(`Evidence ${evidence} under strict/unsupported policy.`);
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
        ` | regime policy ok.`,
      confidence: effectiveProb,
      isOpportunity: true,
    };
  }

  withPolicy(partial: Partial<StrategyPolicy> & { mode?: StrategyPolicyMode }): StrategyLayer {
    return new StrategyLayer({ ...this.policy, ...partial });
  }

  private reducedStake(_risk: StrategyDecisionContext['riskState']): number {
    return Math.max(1, Math.round(this.policy.defaultStake * this.policy.reducedStakeFactor));
  }

  private skip(reason: string): StrategyDecision {
    return { action: 'SKIP', stake: 0, reason, confidence: 0, isOpportunity: false };
  }
}
