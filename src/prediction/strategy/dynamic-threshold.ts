/**
 * Dynamic thresholds — NEVER driven by volume quotas or "behind on 500/day".
 * Only calibration, performance, regime, sample confidence, data quality, agreement.
 */

export interface ThresholdContext {
  baseThreshold: number;
  ece: number;
  realizedVsExpected: number;
  regime: string;
  sampleConfidence: number;
  dataQuality: number;
  modelAgreement: number;
  safetyMargin?: number;
  policyFloor?: number;
}

export interface ThresholdResult {
  threshold: number;
  reason: string;
  floorApplied: boolean;
}

export function computeDynamicThreshold(ctx: ThresholdContext): ThresholdResult {
  const safety = ctx.safetyMargin ?? 0.02;
  const policyFloor = ctx.policyFloor ?? 0.52;
  const hardFloor = 0.5 + ctx.ece + safety;

  let t = ctx.baseThreshold;
  const reasons: string[] = [`base=${ctx.baseThreshold.toFixed(3)}`];

  // Poor calibration → raise bar
  if (ctx.ece > 0.05) {
    t += Math.min(0.08, ctx.ece);
    reasons.push(`ece+${ctx.ece.toFixed(3)}`);
  }

  // Underperforming vs expectation → raise bar
  if (ctx.realizedVsExpected < -0.05) {
    t += 0.03;
    reasons.push('realized_under');
  } else if (ctx.realizedVsExpected > 0.05) {
    t -= 0.01;
    reasons.push('realized_over');
  }

  // Low sample / quality / agreement → raise bar
  if (ctx.sampleConfidence < 0.4) {
    t += 0.02;
    reasons.push('low_sample');
  }
  if (ctx.dataQuality < 0.5) {
    t += 0.02;
    reasons.push('low_quality');
  }
  if (ctx.modelAgreement < 0.4) {
    t += 0.025;
    reasons.push('disagreement');
  }

  // Regime soft adjustments (not volume)
  if (ctx.regime === 'volatile' || ctx.regime === 'anomalous') {
    t += 0.02;
    reasons.push('regime_risk');
  } else if (ctx.regime === 'deep-low' || ctx.regime === 'low-cluster') {
    t -= 0.015;
    reasons.push('regime_reversion');
  }

  let floorApplied = false;
  const floor = Math.max(hardFloor, policyFloor);
  if (t < floor) {
    t = floor;
    floorApplied = true;
    reasons.push(`floor=${floor.toFixed(3)}`);
  }

  // Cap upper so we don't freeze entries forever
  t = Math.min(0.85, t);

  return { threshold: t, reason: reasons.join('|'), floorApplied };
}
