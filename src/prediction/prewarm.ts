/**
 * Pre-warm ACIE + incremental state + calibration + feature engine.
 * Blocks live mode until warm (caller enforces).
 */

import { getLogger } from '../observability/logger.js';
import type { EntryDecisionService } from './entry-decision-service.js';
import { globalIncrementalFeatures } from './features/incremental-features.js';
import { globalIncrementalState } from './state/incremental-state-engine.js';
import { globalCalibrationState } from './calibration/calibration-state.js';
import { featureHotCache } from '../observability/performance/hot-cache.js';
import { globalFeatureEngineV2 } from './features/feature-engine-v2.js';
import { globalModelLifecycle } from './lifecycle/model-lifecycle.js';
import { runRandomnessGate, applyRandomnessGateToFlags } from './validation/randomness-gate.js';
import { loadSnapshotFromFile, saveSnapshotToFile } from './state/state-persistence.js';
import { globalEnsemble } from './ensemble/ensemble-orchestrator.js';
import { globalLookaheadEngine } from './lookahead/lookahead-engine.js';



export interface PrewarmResult {
  historyRounds: number;
  featuresSeeded: boolean;
  acieHistorySize: number;
  stateWarm: boolean;
  calibrationWarm: boolean;
  durationMs: number;
  sequenceModelsEnabled?: boolean;
}

export async function tryRestorePredictionStack(): Promise<boolean> {
  return loadSnapshotFromFile();
}

export async function prewarmPredictionStack(
  entryDecisionService: EntryDecisionService,
  historyLimit = 500
): Promise<PrewarmResult> {
  const logger = getLogger();
  const t0 = performance.now();

  const hist = entryDecisionService.getHistoricalDataService();
  await hist.ensureWarmed(historyLimit);

  const rounds = hist.getRecentRoundsSync(historyLimit);
  if (rounds.length > 0) {
    globalIncrementalState.seed(rounds.map((r) => r.crashPoint));
    globalIncrementalFeatures.seed(rounds);
    featureHotCache.set('latest', globalIncrementalFeatures.toFeatures(), 60_000);
    // Snapshot feature vector once so caches are hot
    globalFeatureEngineV2.snapshotFromState('prewarm', new Date().toISOString());
  }

  let acieSize = 0;
  try {
    const acie = entryDecisionService.getACIE();
    acieSize = acie.historySize();
    if (acieSize < 20 && rounds.length >= 20) {
      acie.seedHistory(
        rounds.map((r) => ({
          roundId: r.id || r.externalRoundId || `prewarm-${r.crashPoint}`,
          crashPoint: r.crashPoint,
          timestamp: r.crashedAt ?? r.createdAt ?? new Date().toISOString(),
        }))
      );
      acieSize = acie.historySize();
    }
  } catch (err) {
    logger.warn(
      { component: 'Prewarm', error: err instanceof Error ? err.message : String(err) },
      'ACIE prewarm partial'
    );
  }

  // Register baseline production model for lifecycle/canary routing
  try {
    if (!globalModelLifecycle.get('acie', 'v3')) {
      globalModelLifecycle.register({
        modelName: 'acie',
        modelVersion: 'v3',
        stage: 'PRODUCTION',
        trafficShare: 1,
        metrics: { ece: 0.05, brier: 0.22, logLoss: 0.55, oosSkill: 0 },
      });
    }
    if (!globalModelLifecycle.get('meta', 'lr-v1')) {
      globalModelLifecycle.register({
        modelName: 'meta',
        modelVersion: 'lr-v1',
        stage: 'SHADOW',
        trafficShare: 0,
        metrics: {},
      });
    }
  } catch { /* ignore */ }

  // §4 randomness gate — only enable sequence models if structure replicates
  try {
    if (rounds.length >= 1000) {
      // Strict gate: sequence models only when ≥50k rounds AND structure replicates
      const gate = runRandomnessGate(rounds.map((r) => r.crashPoint), {
        minRounds: 50_000,
      });
      const flags = applyRandomnessGateToFlags(
        rounds.length >= 50_000 && gate.allowSequenceModels
          ? gate
          : { ...gate, allowSequenceModels: false, summary: gate.summary + ' (strict-50k)' }
      );
      globalEnsemble.setFlags(flags);
      // Lookahead stays off unless full 50k gate allows sequence models
      globalLookaheadEngine.setEnabled(false);
      logger.info(
        {
          component: 'Prewarm',
          randomnessSummary: gate.summary,
          allowSequenceModels: flags.enableMarkov,
          sample: rounds.length,
        },
        'Randomness gate evaluated'
      );
    }
  } catch (err) {
    logger.warn(
      { component: 'Prewarm', error: err instanceof Error ? err.message : String(err) },
      'Randomness gate skipped'
    );
  }

  // Phase 3.1 — persist snapshot after warm (file; Redis optional at composition)
  try {
    await saveSnapshotToFile();
  } catch { /* */ }

  const durationMs = performance.now() - t0;
  const result: PrewarmResult = {
    historyRounds: rounds.length,
    featuresSeeded: rounds.length > 0,
    acieHistorySize: acieSize,
    stateWarm: globalIncrementalState.isWarm(Math.min(50, Math.floor(historyLimit / 4))),
    calibrationWarm: globalCalibrationState.isWarm(),
    durationMs,
  };
  logger.info({ component: 'Prewarm', ...result }, 'Prediction stack pre-warmed');
  return result;
}

export function assertPredictionWarmForLive(minHistory = 50): void {
  if (!globalIncrementalState.isWarm(minHistory)) {
    throw new Error(
      `LIVE MODE BLOCKED: incremental state cold (count=${globalIncrementalState.snapshot().count}, need≥${minHistory})`
    );
  }
}
