/**
 * Ensemble v2 — performance-weighted aggregation + disagreement.
 * Candidate models may be registered but stay weight 0 until feature flags enable them.
 */

import { getLogger } from '../../observability/logger.js';
import { ModelPerformanceTracker, globalModelPerformance } from './model-performance.js';
import { computePerformanceWeights, applySuppression } from './model-weighting.js';
import { agreementScore, modelDisagreement } from './disagreement.js';

export interface ModelScore {
  modelName: string;
  modelVersion: string;
  probability: number;
  confidence: number;
  weight: number;
}

export interface EnsembleResult {
  probability: number;
  confidence: number;
  scores: ModelScore[];
  agreement: number;
  disagreement: number;
  recommendedAction: 'ENTRY' | 'REDUCED_ENTRY' | 'SKIP';
  weights: Record<string, number>;
}

export interface EnsembleFlags {
  enableAutocorrelation: boolean;
  enableMarkov: boolean;
  enableSpectral: boolean;
  enableEntropy: boolean;
  enableStreak: boolean;
}

export const DEFAULT_ENSEMBLE_FLAGS: EnsembleFlags = {
  enableAutocorrelation: false,
  enableMarkov: false,
  enableSpectral: false,
  enableEntropy: false,
  enableStreak: false,
};

const BASE_WEIGHTS: Record<string, number> = {
  FrequencyModel: 0.2,
  ConditionalFrequencyModel: 0.25,
  RegimeAdjustedModel: 0.15,
  StreakAwareModel: 0.15,
  MomentumReversionModel: 0.1,
  ShortWindowBayesianModel: 0.1,
  VolatilityAdjustedModel: 0.05,
  AutocorrelationModel: 0,
  MarkovChainModel: 0,
  SpectralModel: 0,
  EntropyModel: 0,
};

export class EnsembleOrchestrator {
  private readonly logger = getLogger();
  private flags: EnsembleFlags = { ...DEFAULT_ENSEMBLE_FLAGS };

  constructor(
    private readonly performance: ModelPerformanceTracker = globalModelPerformance
  ) {}

  setFlags(flags: Partial<EnsembleFlags>): void {
    this.flags = { ...this.flags, ...flags };
  }

  getFlags(): EnsembleFlags {
    return { ...this.flags };
  }

  combine(scores: ModelScore[], baselineLogLoss = 0.65): EnsembleResult {
    if (scores.length === 0) {
      return {
        probability: 0.5,
        confidence: 0,
        scores: [],
        agreement: 0,
        disagreement: 0,
        recommendedAction: 'SKIP',
        weights: {},
      };
    }

    // Zero-out candidates if flags off
    const filtered = scores.map((s) => {
      if (
        (s.modelName === 'AutocorrelationModel' && !this.flags.enableAutocorrelation) ||
        (s.modelName === 'StreakAwareModel' && !this.flags.enableStreak) ||
        (s.modelName === 'MarkovChainModel' && !this.flags.enableMarkov) ||
        (s.modelName === 'SpectralModel' && !this.flags.enableSpectral) ||
        (s.modelName === 'EntropyModel' && !this.flags.enableEntropy)
      ) {
        return { ...s, weight: 0 };
      }
      return s;
    });

    const names = filtered.map((s) => s.modelName);
    let weights = computePerformanceWeights(names, BASE_WEIGHTS, this.performance.all());
    weights = applySuppression(names, weights, this.performance.all(), baselineLogLoss);

    let wSum = 0;
    let pSum = 0;
    let cSum = 0;
    const weightMap: Record<string, number> = {};
    for (let i = 0; i < filtered.length; i++) {
      // If candidate was zeroed by flag, force 0
      const finalW =
        filtered[i].weight === 0 &&
        (filtered[i].modelName.startsWith('Auto') ||
          filtered[i].modelName.startsWith('Markov') ||
          filtered[i].modelName.startsWith('Spectral') ||
          filtered[i].modelName.startsWith('Entropy'))
          ? 0
          : weights[i];
      weightMap[filtered[i].modelName] = finalW;
      wSum += finalW;
      pSum += filtered[i].probability * finalW;
      cSum += filtered[i].confidence * finalW;
    }

    const probability = wSum > 0 ? pSum / wSum : 0.5;
    const confidence = wSum > 0 ? cSum / wSum : 0;
    const probs = filtered.map((s) => s.probability);
    const disagreement = modelDisagreement(probs);
    const agreement = agreementScore(probs);

    let recommendedAction: EnsembleResult['recommendedAction'] = 'SKIP';
    if (probability >= 0.62 && agreement >= 0.55) recommendedAction = 'ENTRY';
    else if (probability >= 0.57 && agreement >= 0.4) recommendedAction = 'REDUCED_ENTRY';

    this.logger.debug(
      {
        component: 'EnsembleOrchestrator',
        probability,
        agreement,
        disagreement,
        recommendedAction,
      },
      'Ensemble v2 combined'
    );

    return {
      probability,
      confidence,
      scores: filtered.map((s, i) => ({ ...s, weight: weightMap[s.modelName] ?? weights[i] })),
      agreement,
      disagreement,
      recommendedAction,
      weights: weightMap,
    };
  }

  observeOutcome(scores: ModelScore[], actual: 0 | 1): void {
    for (const s of scores) {
      this.performance.observe(s.modelName, s.probability, actual);
    }
  }
}

export const globalEnsemble = new EnsembleOrchestrator();
