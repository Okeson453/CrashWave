/**
 * Online adaptive state — updated on every crash without full batch retrain.
 *
 * Adaptation tiers:
 *   Every crash: sequence, rolling rates, online PSI weights, incremental calibration, drift
 *   Rolling window: heavier validation snapshots
 *   Scheduled/async: full model refresh hooks (optional)
 */

import { ACIE_TARGET, RegimeLabel, SequenceState } from './types.js';

export interface OnlineCalibrationBucket {
  sumPredicted: number;
  sumActual: number;
  count: number;
}

export interface DriftSnapshot {
  detected: boolean;
  brierShort: number;
  brierLong: number;
  residualBias: number;
  reason: string;
}

export interface OnlineAdaptiveState {
  /** Crash count since process start / seed */
  observationCount: number;
  /** Exponentially weighted hit rate for ≥1.30 */
  ewmaHitRate: number;
  /** EWMA of squared residual (online Brier proxy) */
  ewmaBrier: number;
  /** EWMA of signed residual (bias) */
  ewmaResidual: number;
  /** Ensemble model weights (sum ≈ 1) */
  ensembleWeights: Record<string, number>;
  /** Incremental calibration by 10% bin */
  calibrationBuckets: OnlineCalibrationBucket[];
  /** Short vs long window Brier for drift */
  recentSquaredErrors: number[];
  longSquaredErrors: number[];
  lastDrift: DriftSnapshot;
  lastRegime: RegimeLabel;
  regimeDuration: number;
  consecutiveBelow: number;
  consecutiveAbove: number;
  /** Last computed sequence state */
  sequenceState: SequenceState | null;
  /** Last PSI probability emitted before outcome */
  lastPsiProbability: number;
  /** Rounds since last heavy validation */
  sinceHeavyValidation: number;
  lastHeavyValidationAt: number;
}

const MODEL_NAMES = [
  'FrequencyModel',
  'ConditionalFrequencyModel',
  'RegimeAdjustedModel',
  'StreakAwareModel',
] as const;

export type OnlineModelName = (typeof MODEL_NAMES)[number];

function emptyBuckets(): OnlineCalibrationBucket[] {
  return Array.from({ length: 10 }, () => ({
    sumPredicted: 0,
    sumActual: 0,
    count: 0,
  }));
}

export function createInitialOnlineState(): OnlineAdaptiveState {
  const equal = 1 / MODEL_NAMES.length;
  const weights: Record<string, number> = {};
  for (const n of MODEL_NAMES) weights[n] = equal;
  return {
    observationCount: 0,
    ewmaHitRate: 0.65,
    ewmaBrier: 0.25,
    ewmaResidual: 0,
    ensembleWeights: weights,
    calibrationBuckets: emptyBuckets(),
    recentSquaredErrors: [],
    longSquaredErrors: [],
    lastDrift: {
      detected: false,
      brierShort: 0,
      brierLong: 0,
      residualBias: 0,
      reason: 'insufficient data',
    },
    lastRegime: 'unknown',
    regimeDuration: 0,
    consecutiveBelow: 0,
    consecutiveAbove: 0,
    sequenceState: null,
    lastPsiProbability: 0.65,
    sinceHeavyValidation: 0,
    lastHeavyValidationAt: 0,
  };
}

/**
 * Apply one crash outcome into online state (O(1) / O(window) — no full retrain).
 */
export function applyOnlineUpdate(
  state: OnlineAdaptiveState,
  params: {
    crashPoint: number;
    psiProbability: number;
    modelProbabilities: Record<string, number>;
    sequenceState: SequenceState;
    regime: RegimeLabel;
    alpha?: number; // EWMA smoothing
    shortWindow?: number;
    longWindow?: number;
  }
): OnlineAdaptiveState {
  const alpha = params.alpha ?? 0.05;
  const shortWindow = params.shortWindow ?? 50;
  const longWindow = params.longWindow ?? 200;
  const actual = params.crashPoint >= ACIE_TARGET ? 1 : 0;
  const p = Math.max(0.01, Math.min(0.99, params.psiProbability));
  const residual = p - actual;
  const sq = residual * residual;

  const next: OnlineAdaptiveState = {
    ...state,
    ensembleWeights: { ...state.ensembleWeights },
    calibrationBuckets: state.calibrationBuckets.map((b) => ({ ...b })),
    recentSquaredErrors: [...state.recentSquaredErrors],
    longSquaredErrors: [...state.longSquaredErrors],
  };

  next.observationCount = state.observationCount + 1;
  next.ewmaHitRate = alpha * actual + (1 - alpha) * state.ewmaHitRate;
  next.ewmaBrier = alpha * sq + (1 - alpha) * state.ewmaBrier;
  next.ewmaResidual = alpha * residual + (1 - alpha) * state.ewmaResidual;
  next.sequenceState = params.sequenceState;
  next.lastPsiProbability = p;

  // Streaks
  if (actual === 1) {
    next.consecutiveAbove = state.consecutiveAbove + 1;
    next.consecutiveBelow = 0;
  } else {
    next.consecutiveBelow = state.consecutiveBelow + 1;
    next.consecutiveAbove = 0;
  }

  // Regime duration
  if (params.regime === state.lastRegime) {
    next.regimeDuration = state.regimeDuration + 1;
  } else {
    next.lastRegime = params.regime;
    next.regimeDuration = 1;
  }

  // Incremental calibration bucket
  const bin = Math.min(9, Math.floor(p * 10));
  const bucket = next.calibrationBuckets[bin];
  bucket.sumPredicted += p;
  bucket.sumActual += actual;
  bucket.count += 1;

  // Rolling error windows for drift
  next.recentSquaredErrors.push(sq);
  next.longSquaredErrors.push(sq);
  if (next.recentSquaredErrors.length > shortWindow) {
    next.recentSquaredErrors.shift();
  }
  if (next.longSquaredErrors.length > longWindow) {
    next.longSquaredErrors.shift();
  }

  // Online ensemble weight update: reward models closer to actual
  // multiplicative weights update (simple online learning)
  let weightSum = 0;
  for (const name of MODEL_NAMES) {
    const mp = params.modelProbabilities[name] ?? p;
    const mRes = mp - actual;
    const mSq = mRes * mRes;
    // Lower squared error → higher weight; soft update
    const score = Math.exp(-3 * mSq);
    next.ensembleWeights[name] = (state.ensembleWeights[name] ?? equalWeight()) * (0.9 + 0.1 * score);
    weightSum += next.ensembleWeights[name];
  }
  if (weightSum > 0) {
    for (const name of MODEL_NAMES) {
      next.ensembleWeights[name] /= weightSum;
    }
  }

  // Drift: short-window Brier vs long-window Brier
  next.lastDrift = computeDrift(next);
  next.sinceHeavyValidation = state.sinceHeavyValidation + 1;

  return next;
}

function equalWeight(): number {
  return 1 / MODEL_NAMES.length;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function computeDrift(state: OnlineAdaptiveState): DriftSnapshot {
  const brierShort = mean(state.recentSquaredErrors);
  const brierLong = mean(state.longSquaredErrors);
  const residualBias = state.ewmaResidual;
  if (state.recentSquaredErrors.length < 20 || state.longSquaredErrors.length < 40) {
    return {
      detected: false,
      brierShort,
      brierLong,
      residualBias,
      reason: 'warming up',
    };
  }
  const ratio = brierLong > 1e-6 ? brierShort / brierLong : 1;
  const biasBad = Math.abs(residualBias) > 0.12;
  const brierBad = ratio > 1.25 && brierShort > 0.22;
  const detected = biasBad || brierBad;
  return {
    detected,
    brierShort,
    brierLong,
    residualBias,
    reason: detected
      ? biasBad
        ? `residual bias ${residualBias.toFixed(3)}`
        : `short Brier ${brierShort.toFixed(3)} vs long ${brierLong.toFixed(3)}`
      : 'stable',
  };
}

/** Snapshot mean calibration error from online buckets */
export function onlineMeanCalibrationError(state: OnlineAdaptiveState): number {
  let wErr = 0;
  let n = 0;
  for (const b of state.calibrationBuckets) {
    if (b.count < 3) continue;
    const pred = b.sumPredicted / b.count;
    const act = b.sumActual / b.count;
    wErr += Math.abs(pred - act) * b.count;
    n += b.count;
  }
  return n > 0 ? wErr / n : 0.1;
}

export function onlineCalibrationBins(state: OnlineAdaptiveState): Array<{
  predictedRange: [number, number];
  predictedProbability: number;
  actualFrequency: number;
  calibrationError: number;
  sampleSize: number;
}> {
  return state.calibrationBuckets.map((b, i) => {
    const lower = i / 10;
    const upper = (i + 1) / 10;
    if (b.count === 0) {
      return {
        predictedRange: [lower, upper] as [number, number],
        predictedProbability: (lower + upper) / 2,
        actualFrequency: 0,
        calibrationError: 1,
        sampleSize: 0,
      };
    }
    const pred = b.sumPredicted / b.count;
    const act = b.sumActual / b.count;
    return {
      predictedRange: [lower, upper] as [number, number],
      predictedProbability: pred,
      actualFrequency: act,
      calibrationError: Math.abs(pred - act),
      sampleSize: b.count,
    };
  });
}

export { MODEL_NAMES };
