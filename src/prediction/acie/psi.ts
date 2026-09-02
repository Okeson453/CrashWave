/**
 * PSI — Predictive Sequence Intelligence
 * Estimates P(next crash ≥ 1.30× | sequence + state).
 *
 * Inference is optimized for the live hot path (every crash / pre-entry):
 * - No full-history O(n) scans; capped reverse windows
 * - Single-pass short-window stats
 * - estimate() runs models once (estimateModels shares the same path)
 */

import { ACIE_TARGET, PSIOutput, SequenceState, RegimeLabel, SOLRecord } from './types.js';
import { TemporalPatternLearner } from './tpl.js';
import { MODEL_NAMES } from './online-state.js';

export interface ModelEstimate {
  modelName: string;
  probability: number;
}

/** Max SOL records scanned for streak / conditional matching */
const MATCH_SCAN_LIMIT = 600;
/** Min matches before streak-aware overrides baseline */
const STREAK_MIN_MATCHES = 20;
/** Min matches for conditional frequency */
const COND_MIN_MATCHES = 40;
/** Short window for Bayesian / volatility */
const SHORT_WINDOW = 30;

function clamp01(x: number): number {
  return x < 0.01 ? 0.01 : x > 0.99 ? 0.99 : x;
}

function varianceInPlace(xs: number[], n: number): number {
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += xs[i];
  const m = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    v += d * d;
  }
  return v / (n - 1);
}

export class PredictiveSequenceIntelligence {
  private readonly tpl: TemporalPatternLearner;

  /** Scratch buffers reused across calls (avoid GC on hot path) */
  private readonly probScratch: number[] = new Array(7);
  private readonly weightScratch: number[] = new Array(7);
  private readonly modelScratch: ModelEstimate[] = MODEL_NAMES.map((name) => ({
    modelName: name,
    probability: 0.65,
  }));

  constructor(tpl?: TemporalPatternLearner) {
    this.tpl = tpl ?? new TemporalPatternLearner();
  }

  /** Raw per-model estimates (used for online weight updates). */
  estimateModels(params: {
    crashPoints: number[];
    sequenceState: SequenceState;
    regime: RegimeLabel;
    history: readonly SOLRecord[];
    ewmaHitRate?: number;
  }): ModelEstimate[] {
    this.runModelsInto(
      params.crashPoints,
      params.sequenceState,
      params.regime,
      params.history,
      params.ewmaHitRate
    );
    // Return shallow copies so callers can retain results after next call
    return this.modelScratch.map((m) => ({ modelName: m.modelName, probability: m.probability }));
  }

  estimate(params: {
    crashPoints: number[];
    sequenceState: SequenceState;
    regime: RegimeLabel;
    history: readonly SOLRecord[];
    ensembleWeights?: Record<string, number>;
    ewmaHitRate?: number;
  }): PSIOutput {
    const { crashPoints, sequenceState, regime, history } = params;
    this.runModelsInto(
      crashPoints,
      sequenceState,
      regime,
      history,
      params.ewmaHitRate
    );

    const models = this.modelScratch;
    const nModels = models.length;
    for (let i = 0; i < nModels; i++) this.probScratch[i] = models[i].probability;

    this.resolveWeightsInto(models, history.length, params.ensembleWeights);

    let pSum = 0;
    let maxW = -1;
    let primaryIdx = 0;
    for (let i = 0; i < nModels; i++) {
      pSum += this.probScratch[i] * this.weightScratch[i];
      if (this.weightScratch[i] > maxW) {
        maxW = this.weightScratch[i];
        primaryIdx = i;
      }
    }

    const estimatedProbability = clamp01(pSum);
    const modelUncertainty = Math.sqrt(varianceInPlace(this.probScratch, nModels));
    const dataN = history.length > crashPoints.length ? history.length : crashPoints.length;
    const dataUncertainty = 1 / Math.sqrt(dataN > 0 ? dataN : 1);
    const ci = this.parametricUncertaintyInterval(estimatedProbability, modelUncertainty);

    return {
      target: ACIE_TARGET,
      estimatedProbability,
      confidenceInterval: ci,
      sequenceState,
      regime,
      primaryModel: models[primaryIdx]?.modelName ?? 'FrequencyModel',
      ensembleWeight: this.weightScratch[primaryIdx] ?? 1,
      modelUncertainty,
      dataUncertainty,
    };
  }

  /**
   * Combined path: one model pass + ensemble, returns both PSI output and model probs.
   * Prefer this on the live path to avoid double inference.
   */
  estimateWithModels(params: {
    crashPoints: number[];
    sequenceState: SequenceState;
    regime: RegimeLabel;
    history: readonly SOLRecord[];
    ensembleWeights?: Record<string, number>;
    ewmaHitRate?: number;
  }): { psi: PSIOutput; models: ModelEstimate[] } {
    const psi = this.estimate(params);
    const models = this.modelScratch.map((m) => ({
      modelName: m.modelName,
      probability: m.probability,
    }));
    return { psi, models };
  }

  private runModelsInto(
    crashPoints: number[],
    sequenceState: SequenceState,
    regime: RegimeLabel,
    history: readonly SOLRecord[],
    ewmaHitRate?: number
  ): void {
    const baseline =
      ewmaHitRate != null && ewmaHitRate > 0
        ? ewmaHitRate
        : crashPoints.length === 0
          ? 0.65
          : sequenceState.rolling100HitRate > 0
            ? sequenceState.rolling100HitRate
            : 0.65;

    // Conditional frequency — capped reverse scan inside TPL
    const cond = this.tpl.computeConditionalProbability(
      sequenceState,
      history,
      COND_MIN_MATCHES,
      MATCH_SCAN_LIMIT
    );
    const conditional = cond.conditional;

    let regimeAdj = baseline;
    if (regime === 'low-cluster' || regime === 'deep-low') {
      const bump = cond.improvement > 0.02 ? cond.improvement * 0.55 : 0.02;
      regimeAdj = clamp01(baseline + bump);
    } else if (regime === 'volatile') {
      regimeAdj = clamp01(baseline * 0.97);
    } else if (regime === 'high-activity') {
      regimeAdj = clamp01(baseline + 0.025);
    }

    const streakAware = this.fastStreakAware(baseline, sequenceState, history);

    const streakBelow = sequenceState.currentStreakBelow130 | 0;
    const streakAbove = sequenceState.currentStreakAbove130 | 0;
    let momentum = baseline;
    if (streakBelow >= 1) {
      const bump = streakBelow * 0.015;
      momentum = clamp01(baseline + (bump > 0.12 ? 0.12 : bump));
    } else if (streakAbove >= 4) {
      momentum = clamp01(baseline - 0.03);
    }

    // Single-pass last SHORT_WINDOW for Bayesian + volatility
    const short = this.shortWindowStats(crashPoints);
    const priorA = 8;
    const priorB = 4;
    const shortBayesian = clamp01(
      (priorA + short.hits) / (priorA + priorB + short.count)
    );

    let volAdj = baseline;
    if (short.count >= 10) {
      const vol = Math.sqrt(short.variance);
      if (vol > 8) volAdj = clamp01(baseline - 0.04);
      else if (vol < 2.5 && baseline >= 0.6) volAdj = clamp01(baseline + 0.02);
    }

    // Write into reusable scratch (order matches MODEL_NAMES)
    const m = this.modelScratch;
    m[0].probability = clamp01(baseline);
    m[1].probability = clamp01(conditional);
    m[2].probability = clamp01(regimeAdj);
    m[3].probability = clamp01(streakAware);
    m[4].probability = clamp01(momentum);
    m[5].probability = shortBayesian;
    m[6].probability = clamp01(volAdj);
  }

  /** Single reverse pass over last SHORT_WINDOW crash points */
  private shortWindowStats(crashPoints: number[]): {
    count: number;
    hits: number;
    variance: number;
  } {
    const n = crashPoints.length;
    const count = n < SHORT_WINDOW ? n : SHORT_WINDOW;
    if (count === 0) return { count: 0, hits: 0, variance: 0 };

    const start = n - count;
    let hits = 0;
    let sum = 0;
    for (let i = start; i < n; i++) {
      const c = crashPoints[i];
      if (c >= ACIE_TARGET) hits++;
      sum += c;
    }
    const mean = sum / count;
    let varSum = 0;
    if (count >= 2) {
      for (let i = start; i < n; i++) {
        const d = crashPoints[i] - mean;
        varSum += d * d;
      }
      varSum /= count - 1;
    }
    return { count, hits, variance: varSum };
  }

  /**
   * Streak-aware: scan at most MATCH_SCAN_LIMIT recent SOL records (from the end).
   * Avoids O(full history) filter + second pass.
   */
  private fastStreakAware(
    baseline: number,
    sequenceState: SequenceState,
    history: readonly SOLRecord[]
  ): number {
    const len = history.length;
    if (len < 40) return baseline;

    const streak = sequenceState.currentStreakBelow130;
    const start = len > MATCH_SCAN_LIMIT ? len - MATCH_SCAN_LIMIT : 0;
    let matchCount = 0;
    let matchHits = 0;

    for (let i = start; i < len; i++) {
      const s = history[i].sequenceState.currentStreakBelow130;
      const d = s - streak;
      if (d <= 1 && d >= -1) {
        matchCount++;
        if (history[i].reached130) matchHits++;
      }
    }

    if (matchCount < STREAK_MIN_MATCHES) return baseline;
    return matchHits / matchCount;
  }

  private resolveWeightsInto(
    models: ModelEstimate[],
    sampleSize: number,
    online?: Record<string, number>
  ): void {
    const n = models.length;
    if (online && Object.keys(online).length > 0) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const w = online[models[i].modelName] ?? 1 / n;
        this.weightScratch[i] = w;
        sum += w;
      }
      const inv = sum > 0 ? 1 / sum : 1 / n;
      for (let i = 0; i < n; i++) this.weightScratch[i] *= inv;
      return;
    }

    const mature = sampleSize >= 200;
    // Static weights aligned with MODEL_NAMES order
    const raw = mature
      ? [0.12, 0.22, 0.14, 0.16, 0.14, 0.12, 0.1]
      : [0.28, 0.18, 0.12, 0.14, 0.12, 0.1, 0.06];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      this.weightScratch[i] = raw[i] ?? 0.1;
      sum += this.weightScratch[i];
    }
    const inv = sum > 0 ? 1 / sum : 1 / n;
    for (let i = 0; i < n; i++) this.weightScratch[i] *= inv;
  }

  /** Parametric normal-approx interval from model uncertainty — not resampling bootstrap. */
  private parametricUncertaintyInterval(
    mean: number,
    modelUnc: number
  ): [number, number] {
    const spread = modelUnc > 0.03 ? modelUnc : 0.03;
    return [clamp01(mean - 1.64 * spread), clamp01(mean + 1.64 * spread)];
  }
}

export { MODEL_NAMES };
