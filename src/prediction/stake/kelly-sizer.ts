/**
 * Fractional Kelly — consumes calibrated probability only.
 * Not a prediction engine.
 */

export interface KellyInput {
  calibratedProbability: number;
  target: number;
  bankroll: number;
  sampleConfidence: number;
  calibrationConfidence: number;
  evidenceQuality: number;
  modelAgreement: number;
  /** 0 = no drawdown pressure, 1 = max */
  drawdownPressure: number;
  fraction?: number;
  maxBankrollFraction?: number;
}

export interface KellyResult {
  stake: number;
  kellyFull: number;
  kellyFractional: number;
  appliedFraction: number;
  reason: string;
}

export function fractionalKellyStake(input: KellyInput): KellyResult {
  const fraction = input.fraction ?? 0.25;
  const maxFrac = input.maxBankrollFraction ?? 0.05;
  const p = Math.min(0.99, Math.max(0.01, input.calibratedProbability));
  const b = Math.max(0.01, input.target - 1); // net odds
  // Kelly f* = (bp - q) / b where q = 1-p
  const q = 1 - p;
  const kellyFull = (b * p - q) / b;

  if (kellyFull <= 0) {
    return {
      stake: 0,
      kellyFull,
      kellyFractional: 0,
      appliedFraction: 0,
      reason: 'no-edge-kelly-nonpositive',
    };
  }

  const quality =
    clamp(input.sampleConfidence) *
    clamp(input.calibrationConfidence) *
    clamp(input.evidenceQuality) *
    clamp(input.modelAgreement) *
    (1 - 0.7 * clamp(input.drawdownPressure));

  const applied = fraction * quality;
  const kellyFractional = kellyFull * applied;
  const capped = Math.min(kellyFractional, maxFrac);
  const stake = Math.max(0, Math.floor(input.bankroll * capped));

  return {
    stake,
    kellyFull,
    kellyFractional,
    appliedFraction: capped,
    reason: `kelly f*=${kellyFull.toFixed(3)} × ${applied.toFixed(3)} quality, cap=${maxFrac}`,
  };
}

function clamp(x: number): number {
  return Math.max(0, Math.min(1, x));
}
