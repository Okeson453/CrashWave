/**
 * Unified prediction pipeline Phases 4–8:
 * ensemble → meta → calibration → multi-target → opportunity → dynamic threshold
 * → (optional) Kelly, gated by production controller / divergence sheath.
 */

import { randomUUID } from 'crypto';
import { globalIncrementalState } from './state/incremental-state-engine.js';
import { globalCalibrationState } from './calibration/calibration-state.js';
import { globalEnsemble, type ModelScore } from './ensemble/ensemble-orchestrator.js';
import { globalMetaModel, type MetaFeatures } from './models/meta-logistic-model.js';
import {
  globalMultiTargetEngine,
  type MultiTarget,
  type MultiTargetSelection,
} from './multi-target/multi-target-engine.js';
import { globalOpportunityRanker, type OpportunityRecord } from './opportunity/opportunity-ranker.js';
import { computeDynamicThreshold } from './strategy/dynamic-threshold.js';
import { fractionalKellyStake, type KellyResult } from './stake/kelly-sizer.js';
import { globalProductionController } from './lifecycle/production-controller.js';
import { globalFeatureDrift } from './drift/feature-drift.js';
import { globalPredictionDrift } from './drift/prediction-drift.js';
import { globalConceptDrift } from './drift/concept-drift.js';
import { scoreCandidates } from './models/candidate-models.js';
import { FEATURE_VERSION_V2, CURRENT_FEATURE_VERSION } from './features/feature-meta.js';
import { globalLearnedRegimes } from './regimes/learned-clustering.js';
import { globalLookaheadEngine } from './lookahead/lookahead-engine.js';
import { globalOpportunityWindow } from './opportunity/opportunity-window.js';
import { globalModelLifecycle } from './lifecycle/model-lifecycle.js';


export interface PipelineInput {
  baseProbability: number;
  modelScores?: ModelScore[];
  regime: string;
  regimeConfidence?: number;
  dataQuality?: number;
  modelAgreement?: number;
  bankroll?: number;
  baseThreshold?: number;
  executionQuality?: number;
  predictionId?: string;
  featureVersion?: string;
  modelVersion?: string;
  /** Target-specific raw probs if available */
  targetProbabilities?: Partial<Record<MultiTarget, number>>;
}

export interface PipelineResult {
  predictionId: string;
  rawProbability: number;
  metaProbability: number;
  calibratedProbability: number;
  targetSelection: MultiTargetSelection;
  opportunity: OpportunityRecord;
  threshold: number;
  thresholdReason: string;
  kelly: KellyResult | null;
  action: 'ENTRY' | 'REDUCED_ENTRY' | 'SKIP';
  reason: string;
  production: ReturnType<typeof globalProductionController.status>;
}

export function runPredictionPipeline(input: PipelineInput): PipelineResult {
  const production = globalProductionController.status();
  const snap = globalIncrementalState.snapshot();
  const predictionId = input.predictionId ?? randomUUID();

  // Learned regime (only if fitted offline) — never invents clusters at runtime without model
  let learnedRegimeLabel = input.regime;
  let learnedRegimeConfidence = input.regimeConfidence ?? 0.6;
  if (globalLearnedRegimes.isFitted()) {
    const row = [
      snap.ewmaHit13,
      snap.ewma,
      snap.runs.below13,
      snap.runs.above13,
      globalIncrementalState.shortHitRate13(),
      globalIncrementalState.markovPNextAbove13(),
      snap.welford.mean,
      Math.sqrt(Math.max(0, snap.welford.m2 / Math.max(1, snap.welford.n - 1))),
    ];
    const assigned = globalLearnedRegimes.assign(row);
    learnedRegimeLabel = assigned.label;
    learnedRegimeConfidence = assigned.clusterConfidence;
  }


  // Ensemble blend
  const scores: ModelScore[] =
    input.modelScores ??
    [
      {
        modelName: 'FrequencyModel',
        modelVersion: '1',
        probability: input.baseProbability,
        confidence: Math.min(1, snap.count / 100),
        weight: 1,
      },
      {
        modelName: 'MarkovChainModel',
        modelVersion: '1',
        probability: globalIncrementalState.markovPNextAbove13(),
        confidence: Math.min(1, snap.count / 100),
        weight: 1,
      },
      ...scoreCandidates(globalIncrementalState).map((c) => ({
        modelName: c.modelName,
        modelVersion: '1',
        probability: c.probability,
        confidence: Math.min(1, snap.count / 100),
        weight: 1,
      })),
    ];
  const ensemble = globalEnsemble.combine(scores);
  const agreement = input.modelAgreement ?? ensemble.agreement;

  // Meta model
  const calMetrics = globalCalibrationState.metrics();
  const metaFeatures: MetaFeatures = {
    baseProbability: ensemble.probability,
    disagreement: ensemble.disagreement,
    regimeConfidence: learnedRegimeConfidence,
    dataQuality: input.dataQuality ?? Math.min(1, snap.count / 100),
    sampleCount: snap.count,
    recentLogLoss: calMetrics.logLoss || 0.5,
    recentBrier: calMetrics.brier || 0.25,
    ece: calMetrics.ece,
    shortHitRate: globalIncrementalState.shortHitRate13(),
    markovP: globalIncrementalState.markovPNextAbove13(),
  };
  const metaProbability = globalMetaModel.predict(metaFeatures);
  let metaWeight = 0.5;
  try {
    const metaLife = globalModelLifecycle.get('meta', 'lr-v1');
    if (!metaLife || metaLife.stage === 'SHADOW' || metaLife.stage === 'DEPRECATION') {
      metaWeight = 0.15;
    } else if (metaLife.stage === 'CANARY') {
      metaWeight = Math.min(0.5, 0.15 + (metaLife.trafficShare ?? 0.1) * 0.5);
    }
  } catch { /* */ }
  const blended =
    (1 - metaWeight) * ensemble.probability + metaWeight * metaProbability;

  // Calibration
  const calibratedProbability = globalCalibrationState.calibrateWithShrinkage(
    blended,
    learnedRegimeLabel,
    snap.ewmaHit13,
    snap.count
  );

  // Drift monitors (observe predictions)
  globalPredictionDrift.observe(calibratedProbability);
  globalFeatureDrift.observe({
    ewma_hit: snap.ewmaHit13,
    short_hit: globalIncrementalState.shortHitRate13(),
    markov: globalIncrementalState.markovPNextAbove13(),
  });

  // Multi-target
  const hist = {
    1.3: globalIncrementalState.hitRate(1.3),
    2.0: globalIncrementalState.hitRate(2.0),
    5.0: globalIncrementalState.hitRate(5.0),
  } as Record<MultiTarget, number>;
  const rawTargets = {
    1.3: input.targetProbabilities?.[1.3] ?? calibratedProbability,
    2.0: input.targetProbabilities?.[2.0] ?? hist[2.0],
    5.0: input.targetProbabilities?.[5.0] ?? hist[5.0],
  } as Record<MultiTarget, number>;
  const calTargets = {
    1.3: globalCalibrationState.calibrate(rawTargets[1.3], input.regime),
    2.0: globalCalibrationState.calibrate(rawTargets[2.0], input.regime),
    5.0: globalCalibrationState.calibrate(rawTargets[5.0], input.regime),
  } as Record<MultiTarget, number>;

  let targetSelection = globalMultiTargetEngine.select(
    globalMultiTargetEngine.assess({
      probabilities: rawTargets,
      calibrated: calTargets,
      confidence: agreement,
      sampleSize: snap.count,
      historicalHitRates: hist,
    })
  );

  if (!production.multiTargetAllowed && targetSelection.switchedFromDefault) {
    const onlyDefault = globalMultiTargetEngine.assess({
      probabilities: { 1.3: rawTargets[1.3], 2.0: 0, 5.0: 0 },
      calibrated: { 1.3: calTargets[1.3], 2.0: 0, 5.0: 0 },
      confidence: agreement,
      sampleSize: snap.count,
      historicalHitRates: hist,
    });
    targetSelection = {
      selected: onlyDefault.find((a) => a.target === 1.3) ?? targetSelection.selected,
      alternatives: [],
      switchedFromDefault: false,
      reason: 'multi-target disabled by divergence sheath',
    };
  }

  const selected = targetSelection.selected;

  // Dynamic threshold
  let threshold = input.baseThreshold ?? 0.58;
  let thresholdReason = 'static';
  if (production.dynamicThresholdsAllowed) {
    const dyn = computeDynamicThreshold({
      baseThreshold: threshold,
      ece: calMetrics.ece,
      realizedVsExpected: 0,
      regime: input.regime,
      sampleConfidence: Math.min(1, snap.count / 200),
      dataQuality: input.dataQuality ?? Math.min(1, snap.count / 100),
      modelAgreement: agreement,
    });
    threshold = dyn.threshold;
    thresholdReason = dyn.reason;
  } else {
    thresholdReason = 'dynamic-thresholds-disabled';
  }

  // Opportunity rank
  const opportunity = globalOpportunityRanker.scoreAndInsert({
    predictionId,
    target: selected.target,
    probability: selected.rawProbability,
    calibratedProbability: selected.calibratedProbability,
    expectedValue: selected.shrunkEV,
    confidence: selected.confidence,
    regime: learnedRegimeLabel,
    modelVersion: input.modelVersion ?? 'pipeline-v1',
    featureVersion: (() => {
      const fv = input.featureVersion ?? CURRENT_FEATURE_VERSION;
      if (fv !== CURRENT_FEATURE_VERSION && fv !== FEATURE_VERSION_V2) {
        // Soft degrade — do not crash the hot path
        return CURRENT_FEATURE_VERSION;
      }
      return CURRENT_FEATURE_VERSION;
    })(),
    inputs: {
      calibratedEdge: Math.max(0, selected.calibratedProbability - threshold),
      confidence: selected.confidence,
      dataQuality: input.dataQuality ?? Math.min(1, snap.count / 100),
      regimeStability: input.regimeConfidence ?? 0.6,
      modelAgreement: agreement,
      executionQuality: input.executionQuality ?? 0.9,
    },
  });
  globalOpportunityWindow.push(opportunity);

  // Lookahead (no-op when disabled)
  globalLookaheadEngine.evaluate(globalIncrementalState);

  // Kelly
  let kelly: KellyResult | null = null;
  if (production.kellyAllowed && (input.bankroll ?? 0) > 0) {
    kelly = fractionalKellyStake({
      calibratedProbability: selected.calibratedProbability,
      target: selected.target,
      bankroll: input.bankroll!,
      sampleConfidence: Math.min(1, snap.count / 200),
      calibrationConfidence: Math.max(0, 1 - calMetrics.ece),
      evidenceQuality: input.dataQuality ?? 0.7,
      modelAgreement: agreement,
      drawdownPressure: production.divergence.level >= 3 ? 0.8 : 0,
    });
  }

  // Decision
  let action: PipelineResult['action'] = 'SKIP';
  let reason = '';
  if (!production.entriesAllowed) {
    reason = `sheath level ${production.divergence.level}: entries halted`;
  } else if (selected.calibratedProbability < threshold) {
    reason = `P=${selected.calibratedProbability.toFixed(3)} < threshold ${threshold.toFixed(3)} (${thresholdReason})`;
  } else if (opportunity.score <= 0) {
    reason = 'opportunity score ≤ 0';
  } else {
    action = selected.calibratedProbability >= threshold + 0.05 ? 'ENTRY' : 'REDUCED_ENTRY';
    reason = `qualified target=${selected.target} score=${opportunity.score.toFixed(4)}`;
  }

  return {
    predictionId,
    rawProbability: ensemble.probability,
    metaProbability,
    calibratedProbability: selected.calibratedProbability,
    targetSelection,
    opportunity,
    threshold,
    thresholdReason,
    kelly,
    action,
    reason,
    production,
  };
}

/** Call after outcome known */
export function feedbackPredictionPipeline(
  predicted: number,
  actual: 0 | 1,
  metaFeatures?: MetaFeatures
): void {
  globalProductionController.observeOutcome(predicted, actual);
  globalCalibrationState.observe(predicted, actual);
  globalConceptDrift.observe(predicted, actual);
  if (metaFeatures) {
    globalMetaModel.observe(metaFeatures, actual);
  }
}
