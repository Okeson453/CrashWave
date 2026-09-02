export * from './types.js';
export { HistoricalDataService } from './historical-data-service.js';
export { RollingHistoryBuffer } from './rolling-history-buffer.js';
export { FeatureEngine, CURRENT_FEATURE_VERSION } from './features/feature-engine.js';
export { LabelGenerator, CURRENT_TARGET_VERSION } from './labels/label-generator.js';
export { DatasetBuilder } from './datasets/dataset-builder.js';
export { RegimeDetector } from './regimes/regime-detector.js';
export { BaselineStatisticalModel, type PredictiveModel } from './models/baseline-model.js';
export { ModelRegistry } from './models/model-registry.js';
export { PredictionEngine } from './prediction-engine.js';
export { toSignal, isSignalExpired, isSignalFresh } from './signals/signal.js';
export { StatisticalValidator } from './validation/statistical-validator.js';
export { BacktestEngine } from './backtesting/backtest-engine.js';
export { WalkForwardValidator } from './backtesting/walk-forward.js';
export { EntryDecisionService } from './entry-decision-service.js';
export type { EntryDecisionContext, EntryDecisionResult } from './entry-decision-service.js';

// ACIE v3 — 1.30× threshold-probability intelligence
export * from './acie/index.js';

// Phase 1–4 upgrades
export { IncrementalStateEngine, globalIncrementalState } from './state/incremental-state-engine.js';
export { FeatureEngineV2, globalFeatureEngineV2 } from './features/feature-engine-v2.js';
export { FEATURE_VERSION_V2 } from './features/feature-meta.js';
export { CalibrationState, globalCalibrationState } from './calibration/calibration-state.js';
export { EnsembleOrchestrator, globalEnsemble, DEFAULT_ENSEMBLE_FLAGS } from './ensemble/ensemble-orchestrator.js';
export { prewarmPredictionStack, assertPredictionWarmForLive } from './prewarm.js';
export { globalIncrementalFeatures } from './features/incremental-features.js';

// Phases 4–8
export { MetaLogisticModel, globalMetaModel } from './models/meta-logistic-model.js';
export { MultiTargetEngine, globalMultiTargetEngine, MULTI_TARGETS } from './multi-target/multi-target-engine.js';
export { OpportunityRanker, globalOpportunityRanker } from './opportunity/opportunity-ranker.js';
export { computeOpportunityScore } from './opportunity/opportunity-score.js';
export { computeDynamicThreshold } from './strategy/dynamic-threshold.js';
export { fractionalKellyStake } from './stake/kelly-sizer.js';
export { LiveDivergenceMonitor, globalLiveDivergence } from './validation/live-divergence-monitor.js';
export { FeatureDriftMonitor, globalFeatureDrift } from './drift/feature-drift.js';
export { PredictionDriftMonitor, globalPredictionDrift } from './drift/prediction-drift.js';
export { ConceptDriftMonitor, globalConceptDrift } from './drift/concept-drift.js';
export { ModelLifecycleManager, globalModelLifecycle } from './lifecycle/model-lifecycle.js';
export { ProductionController, globalProductionController } from './lifecycle/production-controller.js';
export { runPredictionPipeline, feedbackPredictionPipeline } from './prediction-pipeline.js';

export { LearningScheduler, globalLearningScheduler } from './learning/learning-scheduler.js';
export type { PredictionGeneratedEvent } from './events/prediction-event.js';
export { buildPredictionGeneratedEvent } from './events/prediction-event.js';

export { runRandomnessGate, applyRandomnessGateToFlags } from './validation/randomness-gate.js';
export { validateCalibration } from './validation/calibration-validator.js';
export { evaluateModelGate } from './validation/model-gate.js';
export { runValidationProtocol } from './validation/walk-forward-protocol.js';
export { LearnedRegimeClustering, globalLearnedRegimes } from './regimes/learned-clustering.js';
export { LookaheadEngine, globalLookaheadEngine } from './lookahead/lookahead-engine.js';
export { OpportunityWindow, globalOpportunityWindow } from './opportunity/opportunity-window.js';
export { runDesignAcceptance } from './validation/design-acceptance.js';
export { tickLearningWithHooks, installLearningHooks } from './learning/learning-bootstrap.js';
export { runRegimeFitJob, featureRowsFromCrashPoints } from './regimes/regime-fit-job.js';
export { computeGroupImportance, DEFAULT_FEATURE_GROUPS } from './features/feature-importance.js';
export { fitRegimesOffline } from './workers/regime-fit-offload.js';

export { runAcieWalkForward } from './backtesting/acie-walk-forward.js';
export {
  snapshotPredictionStack,
  loadPredictionStackOnBoot,
  saveSnapshotToFile,
  loadSnapshotFromFile,
} from './state/state-persistence.js';
export type { RiskInputProvider } from '../betting/risk-input-provider.js';
