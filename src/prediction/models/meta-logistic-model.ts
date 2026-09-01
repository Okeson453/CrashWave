/**
 * Phase 5 — Logistic Meta-Model
 * Combines base model probs + regime/quality signals into a calibrated meta probability.
 * Shadow by default until promotion via model lifecycle.
 */

export interface MetaFeatures {
  /** Base ensemble / PSI probability */
  baseProbability: number;
  /** Model disagreement (0–1 scale) */
  disagreement: number;
  /** Regime confidence 0–1 */
  regimeConfidence: number;
  /** Data quality 0–1 */
  dataQuality: number;
  /** Sample size (log-scaled internally) */
  sampleCount: number;
  /** Recent EWMA log-loss of ensemble */
  recentLogLoss: number;
  /** Recent Brier */
  recentBrier: number;
  /** Calibration ECE */
  ece: number;
  /** Short-window hit rate */
  shortHitRate: number;
  /** Markov next-above probability */
  markovP: number;
}

export interface MetaLogisticWeights {
  bias: number;
  baseProbability: number;
  disagreement: number;
  regimeConfidence: number;
  dataQuality: number;
  logSample: number;
  recentLogLoss: number;
  recentBrier: number;
  ece: number;
  shortHitRate: number;
  markovP: number;
}

/** Conservative prior: mostly trust base probability */
export const DEFAULT_META_WEIGHTS: MetaLogisticWeights = {
  bias: -0.4,
  baseProbability: 2.2,
  disagreement: -0.8,
  regimeConfidence: 0.3,
  dataQuality: 0.4,
  logSample: 0.15,
  recentLogLoss: -0.5,
  recentBrier: -0.4,
  ece: -0.6,
  shortHitRate: 0.5,
  markovP: 0.35,
};

function sigmoid(z: number): number {
  if (z > 30) return 1;
  if (z < -30) return 0;
  return 1 / (1 + Math.exp(-z));
}

function clamp01(x: number): number {
  return Math.max(0.01, Math.min(0.99, x));
}

export class MetaLogisticModel {
  readonly modelName = 'MetaLogistic';
  readonly modelVersion = 'meta-lr-v1';
  private weights: MetaLogisticWeights;
  private fitted = false;
  private trainCount = 0;

  constructor(weights: Partial<MetaLogisticWeights> = {}) {
    this.weights = { ...DEFAULT_META_WEIGHTS, ...weights };
  }

  predict(f: MetaFeatures): number {
    const w = this.weights;
    const logSample = Math.log1p(Math.max(0, f.sampleCount));
    const z =
      w.bias +
      w.baseProbability * f.baseProbability +
      w.disagreement * f.disagreement +
      w.regimeConfidence * f.regimeConfidence +
      w.dataQuality * f.dataQuality +
      w.logSample * (logSample / 10) +
      w.recentLogLoss * f.recentLogLoss +
      w.recentBrier * f.recentBrier +
      w.ece * f.ece +
      w.shortHitRate * f.shortHitRate +
      w.markovP * f.markovP;
    return clamp01(sigmoid(z));
  }

  /**
   * Online SGD on log-loss. Small learning rate; safe for continuous learning.
   */
  observe(f: MetaFeatures, actual: 0 | 1, lr = 0.02): void {
    const p = this.predict(f);
    const err = p - actual;
    const logSample = Math.log1p(Math.max(0, f.sampleCount)) / 10;
    this.weights.bias -= lr * err;
    this.weights.baseProbability -= lr * err * f.baseProbability;
    this.weights.disagreement -= lr * err * f.disagreement;
    this.weights.regimeConfidence -= lr * err * f.regimeConfidence;
    this.weights.dataQuality -= lr * err * f.dataQuality;
    this.weights.logSample -= lr * err * logSample;
    this.weights.recentLogLoss -= lr * err * f.recentLogLoss;
    this.weights.recentBrier -= lr * err * f.recentBrier;
    this.weights.ece -= lr * err * f.ece;
    this.weights.shortHitRate -= lr * err * f.shortHitRate;
    this.weights.markovP -= lr * err * f.markovP;
    this.trainCount += 1;
    if (this.trainCount >= 50) this.fitted = true;
  }

  /** Batch fit via multiple SGD epochs */
  fit(rows: Array<{ features: MetaFeatures; y: 0 | 1 }>, epochs = 12, lr = 0.03): void {
    if (rows.length < 30) return;
    for (let e = 0; e < epochs; e++) {
      for (const row of rows) {
        this.observe(row.features, row.y, lr / Math.sqrt(e + 1));
      }
    }
    this.fitted = true;
  }

  isFitted(): boolean {
    return this.fitted;
  }

  getWeights(): MetaLogisticWeights {
    return { ...this.weights };
  }

  getTrainCount(): number {
    return this.trainCount;
  }
}

export const globalMetaModel = new MetaLogisticModel();
