/**
 * EntryDecisionService — live bridge:
 *   Round context → Rolling history + ACIE continuous learning → Signal → RiskEngine
 *
 * Critical path has NO database I/O.
 * ACIE onCrash must run on every completed crash (event loop) before the next entry.
 */

import { getLogger } from '../observability/logger.js';
import { RiskEngine } from '../betting/risk-engine.js';
import { RiskEvaluationInput, RiskEvaluationResult } from '../betting/types.js';
import { HistoricalDataService } from './historical-data-service.js';
import { PredictionEngine } from './prediction-engine.js';
import { PredictionSignal, ThresholdTarget } from './types.js';
import { isSignalFresh } from './signals/signal.js';
import {
  PredictionRepository,
  InMemoryPredictionRepository,
} from '../persistence/repositories/prediction-repo.js';
import type { OpportunityRanker as DecisionOpportunityRanker } from '../opportunity/ranker.js';
import { bridgeOpportunityToDecisionRanker } from '../opportunity/prediction-bridge.js';
import { globalCalibrationState } from './calibration/calibration-state.js';

import { RoundRepository } from '../persistence/repositories/round-repo.js';
import { ACIEEngine } from './acie/engine.js';
import { globalLiveDivergence } from './validation/live-divergence-monitor.js';
import { isReadyForLive } from '../observability/readiness.js';
import { saveSnapshotToFile } from './state/state-persistence.js';
import { onlineMeanCalibrationError } from './acie/online-state.js';
import type { CrashLearningResult } from './acie/engine.js';
import type { StrategyRiskState } from './acie/types.js';
import { randomUUID } from 'crypto';
import {
  LatencyTimer,
  globalEntryLatencyWindow,
} from '../observability/performance/latency.js';
import { predictionHotCache } from '../observability/performance/hot-cache.js';
import { globalIncrementalFeatures } from './features/incremental-features.js';
import { globalIncrementalState } from './state/incremental-state-engine.js';
import {
  runPredictionPipeline,
  feedbackPredictionPipeline,
} from './prediction-pipeline.js';
import { globalProductionController } from './lifecycle/production-controller.js';
import { tickLearningWithHooks } from './learning/learning-bootstrap.js';
import { assertPredictionWarmForLive } from './prewarm.js';
import { assertFeatureVersionMatch } from './features/feature-version-assert.js';
import { FEATURE_VERSION_V2 } from './features/feature-meta.js';
import type { SheathMode } from '../core/sheath-mode/index.js';

import { PredictionStateRegistry, type PredictionStateSnapshot } from './state-snapshot.js';

export interface EntryDecisionContext {
  roundId: string;
  externalRoundId?: string | null;
  sessionId?: string | null;
  decisionTimestamp: string;
  riskInput: RiskEvaluationInput;
  target?: ThresholdTarget;
  historyLimit?: number;
  minHistory?: number;
}

export interface EntryDecisionResult {
  signal: PredictionSignal | null;
  riskResult: RiskEvaluationResult;
  predictionPersisted: boolean;
  acie?: CrashLearningResult['evaluation'] | null;
}

export class EntryDecisionService {
  private readonly logger = getLogger();
  private readonly predictionEngine: PredictionEngine;
  private readonly historicalData: HistoricalDataService;
  private readonly riskEngine: RiskEngine;
  private readonly predictionRepo: PredictionRepository | InMemoryPredictionRepository;
  private readonly acie: ACIEEngine;
  /** When true, ACIE probability drives the signal (legacy model still runs for features/log). */
  private readonly preferAcie: boolean;
  private lastSignal: PredictionSignal | null = null;
  private acieSeeded = false;
  private readonly stateRegistry: PredictionStateRegistry;
  private lastStateSnapshot: PredictionStateSnapshot;
  private lastEmittedProbability: number | null = null;
  private crashCountForSnapshot = 0;
  private sheathMode: SheathMode | null = null;
  private usePipeline = true;
  private provenanceRepo: unknown = null;
  private decisionRanker: DecisionOpportunityRanker | null = null;

  constructor(opts?: {
    predictionEngine?: PredictionEngine;
    historicalData?: HistoricalDataService;
    riskEngine?: RiskEngine;
    predictionRepo?: PredictionRepository | InMemoryPredictionRepository;
    roundRepo?: RoundRepository;
    acie?: ACIEEngine;
    preferAcie?: boolean;
    sheathMode?: SheathMode | null;
    usePipeline?: boolean;
    provenanceRepo?: unknown;
    decisionRanker?: DecisionOpportunityRanker | null;
  }) {
    this.predictionEngine = opts?.predictionEngine ?? new PredictionEngine();
    this.historicalData =
      opts?.historicalData ??
      new HistoricalDataService(opts?.roundRepo ?? new RoundRepository());
    this.riskEngine = opts?.riskEngine ?? new RiskEngine();
    this.predictionRepo = opts?.predictionRepo ?? new InMemoryPredictionRepository();
    this.acie = opts?.acie ?? new ACIEEngine();
    this.preferAcie = opts?.preferAcie ?? true;
    this.sheathMode = opts?.sheathMode ?? null;
    this.usePipeline = opts?.usePipeline ?? true;
    this.provenanceRepo = opts?.provenanceRepo ?? null;
    this.decisionRanker = opts?.decisionRanker ?? null;
    this.stateRegistry = new PredictionStateRegistry();
    this.lastStateSnapshot = this.stateRegistry.snapshot();
  }

  getHistoricalDataService(): HistoricalDataService {
    return this.historicalData;
  }

  setDecisionRanker(ranker: DecisionOpportunityRanker | null): void {
    this.decisionRanker = ranker;
  }

  setProvenanceRepo(repo: unknown): void {
    this.provenanceRepo = repo;
  }

  getACIE(): ACIEEngine {
    return this.acie;
  }

  getLastEmittedProbability(): number | null {
    return this.lastEmittedProbability;
  }

  getStateSnapshot(): PredictionStateSnapshot {
    return this.stateRegistry.snapshot();
  }

  publishLearningState(update: Partial<Omit<PredictionStateSnapshot, 'version' | 'publishedAt'>> = {}): PredictionStateSnapshot {
    this.lastStateSnapshot = this.stateRegistry.publish(update);
    return this.lastStateSnapshot;
  }

  /**
   * Event-loop hook: every completed crash must call this so ACIE learns continuously.
   * Safe to call multiple times for the same roundId (engine is idempotent).
   */
  observeCrash(
    roundId: string,
    crashPoint: number,
    riskState?: Partial<StrategyRiskState>
  ): CrashLearningResult {
    this.ensureAcieSeeded();
    // O(1) incremental feature update (feeds hot feature cache)
    globalIncrementalFeatures.onCrash(crashPoint);
    // Phase 4: feed last emitted probability into calibration (if present on snapshot)
    try {
      const actual: 0 | 1 = crashPoint >= 1.3 ? 1 : 0;
      if (this.lastEmittedProbability != null && this.lastEmittedProbability > 0) {
        globalCalibrationState.observe(this.lastEmittedProbability, actual, 'global');
        feedbackPredictionPipeline(this.lastEmittedProbability, actual);
        const div = globalLiveDivergence.observe(this.lastEmittedProbability, actual);
        if (div.actions.fullSheathHaltEntries) {
          this.logger.warn(
            { component: 'EntryDecisionService', level: div.level, reason: div.reason },
            'Live divergence full sheath — halt entries'
          );
          try {
            this.sheathMode?.reportTriggers([
              {
                id: 'prediction_divergence',
                severity: 'critical',
                message: div.reason ?? `divergence level ${div.level}`,
                detectedAt: new Date().toISOString(),
                metadata: { level: div.level },
              },
            ]);
          } catch { /* */ }
          this.publishLearningState({
            divergenceLevel: div.level,
            divergenceReason: div.reason ?? undefined,
          } as never);
        } else if (div.actions.lockConservativeBaseline) {
          try {
            this.sheathMode?.reportTriggers([
              {
                id: 'prediction_calibration_degraded',
                severity: 'high',
                message: div.reason ?? 'conservative baseline lock',
                detectedAt: new Date().toISOString(),
                metadata: { level: div.level },
              },
            ]);
          } catch { /* */ }
        }

      }
      tickLearningWithHooks(this.sheathMode);
      const prod = globalProductionController.status();
      this.sheathMode?.reportPredictionHealth({
        divergenceLevel: prod.divergence.level,
        ece: prod.divergence.eceProxy,
        reason: prod.divergence.reason,
        coldState: !globalIncrementalState.isWarm(30),
      });
    } catch { /* non-critical */ }
    this.crashCountForSnapshot += 1;
    if (this.crashCountForSnapshot % 25 === 0) {
      void saveSnapshotToFile(undefined, this.acie).catch(() => undefined);
    }
    const result = this.acie.onCrash(
      {
        roundId,
        crashPoint,
        timestamp: new Date().toISOString(),
      },
      riskState
    );
    this.logger.debug(
      {
        component: 'EntryDecisionService',
        roundId,
        crashPoint,
        reached130: result.reached130,
        heavy: result.heavyValidationRan,
        action: result.evaluation.strategy.action,
      },
      'ACIE onCrash learning tick'
    );
    return result;
  }

  async evaluateEntry(ctx: EntryDecisionContext): Promise<EntryDecisionResult> {
    if (ctx.riskInput?.mode === 'live' && !isReadyForLive()) {
      this.logger.warn({ component: 'EntryDecisionService' }, 'Live entry blocked — prediction not ready');
      const riskResult = this.riskEngine.evaluate(ctx.riskInput);
      return {
        signal: null,
        riskResult: { ...riskResult, approved: false, rejectionReason: 'PREDICTION_NOT_READY', firstFailure: 'prediction_not_ready' },
        predictionPersisted: false,
        acie: null,
      };
    }

    const timer = new LatencyTimer();
    const target = ctx.target ?? 1.3;
    const historyLimit = ctx.historyLimit ?? 100;
    const minHistory = ctx.minHistory ?? 20;

    // Never perform database warm-up on the latency-critical decision path.
    // Startup prewarm is mandatory; if it is unavailable, fail closed for this decision.
    if (!this.historicalData.getBuffer().isWarmed()) {
      this.logger.warn(
        { component: 'EntryDecisionService', roundId: ctx.roundId },
        'Prediction history is not warm; rejecting decision without DB I/O'
      );
      const riskResult = this.riskEngine.evaluate({ ...ctx.riskInput, predictionSignal: undefined });
      return { signal: null, riskResult, predictionPersisted: false, acie: null };
    }
    this.ensureAcieSeeded();
    const stateSnapshot = this.stateRegistry.snapshot();
    timer.record('history');
    timer.mark('post_history');

    const prior = this.historicalData.getRecentRoundsSync(
      historyLimit,
      ctx.roundId,
      ctx.externalRoundId
    );

    let signal: PredictionSignal | null = null;
    let acieEval: CrashLearningResult['evaluation'] | null = null;

    const riskPartial: Partial<StrategyRiskState> = {
      balance: ctx.riskInput.currentBalance ?? 0,
      consecutiveLosses: ctx.riskInput.consecutiveErrors ?? 0,
      dailyEntriesUsed: ctx.riskInput.dailyEntriesConfirmed,
      dailyEntriesLimit: ctx.riskInput.maxDailyEntries,
    };

    if (prior.length >= minHistory || this.acie.historySize() >= minHistory) {
      // Continuous ACIE decision for *next* opportunity (does not learn; learn on crash)
      acieEval = this.acie.evaluateNext(riskPartial);
      timer.record('prediction', 'post_history');

      // V1.1 fast path: skip legacy model on critical path when ACIE is preferred.
      let legacy: PredictionSignal | null = null;
      if (!this.preferAcie && prior.length >= minHistory) {
        try {
          legacy = this.predictionEngine.predict({
            priorRounds: prior,
            targetRoundId: ctx.roundId,
            timestamp: ctx.decisionTimestamp,
            target,
          });
        } catch (err) {
          this.logger.warn(
            { component: 'EntryDecisionService', error: String(err) },
            'Legacy prediction failed'
          );
        }
      }

      if (this.preferAcie && acieEval) {
        const p = acieEval.psi.estimatedProbability;
        const conf = Math.max(0, Math.min(1, 1 - acieEval.psi.modelUncertainty));
        const expires = new Date(new Date(ctx.decisionTimestamp).getTime() + 45_000).toISOString();
        const calibrated = globalCalibrationState.calibrateWithShrinkage(
          p,
          String(acieEval.regime ?? 'global'),
          p,
          this.acie.historySize()
        );
        signal = {
          predictionId: randomUUID(),
          timestamp: ctx.decisionTimestamp,
          modelVersion: stateSnapshot.modelVersion,
          featureVersion: stateSnapshot.featureVersion,
          target,
          score: calibrated,
          probability: calibrated,
          confidence: conf,
          regimeId: acieEval.regime,
          dataQuality: Math.min(1, this.acie.historySize() / 200),
          reasoning: Object.freeze([
            acieEval.strategy.reason,
            `evidence=${acieEval.evidence.status}`,
            `regime=${acieEval.regime}`,
          ]),
          expiresAt: expires,
          featureSummary: Object.freeze({
            stateVersion: stateSnapshot.version,
            regimeVersion: stateSnapshot.regimeVersion,
            calibrationVersion: stateSnapshot.calibrationVersion,
            psiProbability: p,
            modelUncertainty: acieEval.psi.modelUncertainty,
            dataUncertainty: acieEval.psi.dataUncertainty,
          }),
        };
        if (!acieEval.signal) {
          this.logger.info(
            {
              component: 'EntryDecisionService',
              reason: acieEval.strategy.reason,
              action: acieEval.strategy.action,
            },
            'ACIE strategy: no entry opportunity'
          );
        }

        // Phase 4–8 pipeline: calibration, meta, multi-target, opportunity, thresholds, sheath
        if (this.usePipeline && signal) {
          signal = this.applyPipelineToSignal(signal, acieEval, ctx);
        }
      } else if (legacy) {
        signal = legacy;
        if (this.usePipeline && signal) {
          signal = this.applyPipelineToSignal(signal, null, ctx);
        }
      }

      if (
        signal &&
        (!Number.isFinite(signal.probability) ||
          signal.probability < 0 ||
          signal.probability > 1 ||
          !Number.isFinite(signal.confidence) ||
          signal.confidence < 0 ||
          signal.confidence > 1)
      ) {
        this.logger.warn(
          { component: 'EntryDecisionService', predictionId: signal.predictionId },
          'Invalid signal bounds — discarding'
        );
        signal = null;
      } else if (signal && !isSignalFresh(signal, 60_000, new Date(ctx.decisionTimestamp))) {
        this.logger.warn(
          { component: 'EntryDecisionService', predictionId: signal.predictionId },
          'Signal already stale — discarding'
        );
        signal = null;
      } else if (signal) {
        this.lastSignal = signal;
        this.lastEmittedProbability = signal.probability;
        // Honest prediction quality labels (P1)
        ((signal as unknown) as Record<string, unknown>).modelFamily = 'acie-heuristic-ensemble';
        ((signal as unknown) as Record<string, unknown>).heuristic = true;
        ((signal as unknown) as Record<string, unknown>).trainable = false;
        ((signal as unknown) as Record<string, unknown>).modelScope = 'global';
        ((signal as unknown) as Record<string, unknown>).modelVersion = 'acie-v3';
        try {
          ((signal as unknown) as Record<string, unknown>).calibrationError = onlineMeanCalibrationError(
            this.acie.getOnlineState()
          );
          ((signal as unknown) as Record<string, unknown>).ewmaBrier = this.acie.getOnlineState().ewmaBrier;
        } catch { /* */ }

      }
    } else {
      this.logger.info(
        { component: 'EntryDecisionService', priorCount: prior.length, minHistory },
        'Insufficient history for prediction'
      );
    }

    // Risk remains final authority — attach prediction signal when present
    const riskInput: RiskEvaluationInput = {
      ...ctx.riskInput,
      predictionSignal: signal
        ? {
            predictionId: signal.predictionId,
            probability: signal.probability,
            confidence: signal.confidence,
            target: signal.target,
            dataQuality: signal.dataQuality,
            expiresAt: signal.expiresAt,
          }
        : ctx.riskInput.predictionSignal,
      minPredictionProbability: ctx.riskInput.minPredictionProbability,
      minPredictionConfidence: ctx.riskInput.minPredictionConfidence,
    };

    // ACIE SKIP → do not present signal as acceptable opportunity
    if (acieEval && !acieEval.signal && this.preferAcie) {
      riskInput.predictionSignal = undefined;
    }

    // Feature version consistency (Phase 2.7)
    if (signal) {
      try {
        assertFeatureVersionMatch(signal.featureVersion);
      } catch (err) {
        this.logger.warn(
          { component: 'EntryDecisionService', error: String(err), featureVersion: signal.featureVersion, engine: FEATURE_VERSION_V2 },
          'Feature version mismatch — discarding signal for live decision'
        );
        if (ctx.riskInput.mode === 'live') signal = null;
      }
    }

    // Live warm-state gate (design §21)
    if (ctx.riskInput.mode === 'live') {
      try {
        assertPredictionWarmForLive(40);
      } catch (err) {
        this.logger.warn(
          { component: 'EntryDecisionService', error: String(err) },
          'LIVE blocked — prediction stack cold'
        );
        this.sheathMode?.reportPredictionHealth({ divergenceLevel: 0, coldState: true });
        riskInput.predictionSignal = undefined;
        signal = null;
      }
    }

    // Production / divergence sheath may block entries (design §25–26)
    {
      const prodStatus = globalProductionController.status();
      if (!prodStatus.entriesAllowed || this.sheathMode?.isPredictionEntriesBlocked()) {
        this.logger.info(
          {
            component: 'EntryDecisionService',
            divergenceLevel: prodStatus.divergence.level,
            sheath: this.sheathMode?.getState(),
          },
          'Entries blocked by prediction sheath / divergence'
        );
        riskInput.predictionSignal = undefined;
      }
    }

    timer.mark('pre_risk');
    const riskResult = this.riskEngine.evaluate(riskInput);
    timer.record('risk', 'pre_risk');

    if (signal) {
      this.persistAsync(signal, ctx, riskResult, target);
      // Hot cache for subsequent ranking / workers within same round window
      predictionHotCache.set(
        ctx.roundId,
        {
          probability: signal.probability,
          confidence: signal.confidence,
          regimeId: signal.regimeId ?? null,
          modelVersion: signal.modelVersion,
          reasoning: signal.reasoning,
        },
        5_000
      );
    }

    const totalMs = timer.record('entry_total');
    globalEntryLatencyWindow.push(totalMs);

    this.logger.info(
      {
        component: 'EntryDecisionService',
        roundId: ctx.roundId,
        approved: riskResult.approved,
        probability: signal?.probability,
        model: signal?.modelVersion,
        acieAction: acieEval?.strategy.action,
        latencyMs: Math.round(totalMs * 100) / 100,
        entryP99Estimate: Math.round(globalEntryLatencyWindow.p99() * 100) / 100,
      },
      riskResult.approved ? 'Entry APPROVED' : 'Entry REJECTED'
    );

    return { signal, riskResult, predictionPersisted: false, acie: acieEval };
  }

  private ensureAcieSeeded(): void {
    if (this.acieSeeded) return;
    try {
      const recent = this.historicalData.getRecentRoundsSync(500);
      if (recent.length >= 20) {
        this.acie.seedHistory(
          recent.map((r) => ({
            roundId: r.id || r.externalRoundId || randomUUID(),
            crashPoint: r.crashPoint,
            timestamp: r.crashedAt ?? r.createdAt,
          }))
        );
        this.logger.info(
          { component: 'EntryDecisionService', seeded: recent.length },
          'ACIE seeded from rolling history'
        );
      }
      this.acieSeeded = true;
    } catch (err) {
      this.logger.warn(
        { component: 'EntryDecisionService', error: String(err) },
        'ACIE seed skipped'
      );
      this.acieSeeded = true;
    }
  }


  /**
   * Apply Phase 4–8 pipeline on top of ACIE/legacy signal:
   * ensemble + meta + calibration + multi-target + opportunity + dynamic threshold.
   */
  private applyPipelineToSignal(
    signal: PredictionSignal,
    acieEval: CrashLearningResult['evaluation'] | null,
    ctx: EntryDecisionContext
  ): PredictionSignal {
    const regime = String(acieEval?.regime ?? signal.regimeId ?? 'normal');
    const pipeline = runPredictionPipeline({
      baseProbability: signal.probability,
      regime,
      regimeConfidence: Math.min(1, this.acie.historySize() / 200),
      dataQuality: signal.dataQuality,
      bankroll: ctx.riskInput.currentBalance ?? 0,
      baseThreshold: 0.58,
      predictionId: signal.predictionId,
      featureVersion: signal.featureVersion,
      modelVersion: signal.modelVersion,
    });

    const target = pipeline.targetSelection.selected.target as ThresholdTarget;
    const expires = signal.expiresAt;
    const reasoning = Object.freeze([
      ...signal.reasoning,
      pipeline.reason,
      pipeline.targetSelection.reason,
      `threshold=${pipeline.threshold.toFixed(3)} (${pipeline.thresholdReason})`,
      `metaP=${pipeline.metaProbability.toFixed(3)}`,
      `oppScore=${pipeline.opportunity.score.toFixed(4)}`,
    ]);

    const probability = pipeline.calibratedProbability;
    const confidence = pipeline.opportunity.confidence;

    // Unify prediction opportunity with decision-layer ranker
    try {
      if (this.decisionRanker) {
        bridgeOpportunityToDecisionRanker(this.decisionRanker, pipeline.opportunity);
      }
    } catch {
      /* non-critical */
    }

    return {
      predictionId: pipeline.predictionId || signal.predictionId,
      timestamp: signal.timestamp,
      modelVersion: signal.modelVersion,
      featureVersion: signal.featureVersion,
      target,
      score: probability,
      probability,
      confidence,
      regimeId: regime,
      dataQuality: signal.dataQuality,
      reasoning,
      expiresAt: expires,
      featureSummary: Object.freeze({
        ...signal.featureSummary,
        metaProbability: pipeline.metaProbability,
        rawPipelineProbability: pipeline.rawProbability,
        opportunityScore: pipeline.opportunity.score,
        opportunityRank: pipeline.opportunity.rank,
        pipelineThreshold: pipeline.threshold,
        selectedTarget: target,
        shrunkEV: pipeline.targetSelection.selected.shrunkEV,
        divergenceLevel: pipeline.production.divergence.level,
      }),
    };
  }

  private persistAsync(
    signal: PredictionSignal,
    ctx: EntryDecisionContext,
    riskResult: RiskEvaluationResult,
    target: ThresholdTarget
  ): void {
    void (async () => {
      try {
        await this.predictionRepo.create({
          signal,
          sessionId: ctx.sessionId,
          roundId: ctx.roundId,
          externalRoundId: ctx.externalRoundId,
          regimeName: signal.regimeId,
        });
        await this.predictionRepo.resolveOutcome({
          predictionId: signal.predictionId,
          roundId: ctx.roundId,
          riskApproved: riskResult.approved,
          riskRejectionReason: riskResult.rejectionReason,
          betExecuted: false,
          targetThreshold: target,
        });

        // Full provenance (migration 025) — best-effort
        const fs = signal.featureSummary as Record<string, number>;
        const raw = Number(fs.rawPipelineProbability ?? signal.probability);
        const meta = Number(fs.metaProbability ?? signal.probability);
        const opp = Number(fs.opportunityScore ?? 0);
        try {
          const prov = this.provenanceRepo as {
            enrichPrediction?: (p: unknown) => Promise<unknown>;
            recordCalibration?: (p: unknown) => Promise<unknown>;
            recordOpportunity?: (p: unknown) => Promise<unknown>;
            recordModelScores?: (id: string, s: unknown[]) => Promise<unknown>;
          } | null;
          if (prov && typeof prov.enrichPrediction === 'function') {
            await prov.enrichPrediction({
              predictionId: signal.predictionId,
              calibratedProbability: signal.probability,
              rawProbability: raw,
              opportunityScore: opp,
              metaProbability: meta,
              calibrationVersion: globalCalibrationState.version,
            });
          }
          if (prov && typeof prov.recordCalibration === 'function') {
            await prov.recordCalibration({
              predictionId: signal.predictionId,
              rawProbability: raw,
              calibratedProbability: signal.probability,
              calibrationVersion: globalCalibrationState.version,
              regime: signal.regimeId ?? undefined,
            });
          }
          if (prov && typeof prov.recordOpportunity === 'function') {
            await prov.recordOpportunity({
              opportunityId: `opp-${signal.predictionId}`,
              predictionId: signal.predictionId,
              target: signal.target,
              score: opp,
              rank: Number(fs.opportunityRank ?? 0) || undefined,
              calibratedProbability: signal.probability,
              regime: signal.regimeId ?? undefined,
            });
          }
          if (prov && typeof prov.recordModelScores === 'function') {
            await prov.recordModelScores(signal.predictionId, [
            {
              modelName: 'pipeline',
              modelVersion: signal.modelVersion,
              probability: signal.probability,
              weight: 1,
            },
            {
              modelName: 'meta',
              modelVersion: 'lr-v1',
              probability: meta,
              weight: 0.5,
            },
          ]);
          }
        } catch {
          /* provenance tables may not exist yet */
        }
      } catch (err) {
        this.logger.error(
          {
            component: 'EntryDecisionService',
            predictionId: signal.predictionId,
            error: err instanceof Error ? err.message : String(err),
          },
          'Async prediction persistence failed'
        );
      }
    })();
  }

  async resolveActualOutcome(opts: {
    predictionId: string;
    roundId?: string;
    actualCrashPoint: number;
    targetThreshold: number;
    betExecuted?: boolean;
  }): Promise<void> {
    await this.predictionRepo.resolveOutcome({
      predictionId: opts.predictionId,
      roundId: opts.roundId,
      actualCrashPoint: opts.actualCrashPoint,
      targetThreshold: opts.targetThreshold,
      betExecuted: opts.betExecuted ?? false,
    });
  }

  resolveActualOutcomeAsync(opts: {
    predictionId: string;
    roundId?: string;
    actualCrashPoint: number;
    targetThreshold: number;
    betExecuted?: boolean;
  }): void {
    void this.resolveActualOutcome(opts).catch((err) => {
      this.logger.error(
        {
          component: 'EntryDecisionService',
          predictionId: opts.predictionId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Async outcome resolution failed'
      );
    });
  }

  getLastSignal(): PredictionSignal | null {
    return this.lastSignal;
  }

  getPredictionEngine(): PredictionEngine {
    return this.predictionEngine;
  }
}
