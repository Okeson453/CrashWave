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
