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
import { RoundRepository } from '../persistence/repositories/round-repo.js';
import { ACIEEngine } from './acie/engine.js';
import type { CrashLearningResult } from './acie/engine.js';
import type { StrategyRiskState } from './acie/types.js';
import { randomUUID } from 'crypto';

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

  constructor(opts?: {
    predictionEngine?: PredictionEngine;
    historicalData?: HistoricalDataService;
    riskEngine?: RiskEngine;
    predictionRepo?: PredictionRepository | InMemoryPredictionRepository;
    roundRepo?: RoundRepository;
    acie?: ACIEEngine;
    preferAcie?: boolean;
  }) {
    this.predictionEngine = opts?.predictionEngine ?? new PredictionEngine();
    this.historicalData =
      opts?.historicalData ??
      new HistoricalDataService(opts?.roundRepo ?? new RoundRepository());
    this.riskEngine = opts?.riskEngine ?? new RiskEngine();
    this.predictionRepo = opts?.predictionRepo ?? new InMemoryPredictionRepository();
    this.acie = opts?.acie ?? new ACIEEngine();
    this.preferAcie = opts?.preferAcie ?? true;
  }

  getHistoricalDataService(): HistoricalDataService {
    return this.historicalData;
  }

  getACIE(): ACIEEngine {
    return this.acie;
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
    const target = ctx.target ?? 1.3;
    const historyLimit = ctx.historyLimit ?? 100;
    const minHistory = ctx.minHistory ?? 20;

    if (!this.historicalData.getBuffer().isWarmed()) {
      await this.historicalData.ensureWarmed(Math.max(historyLimit, 200));
    }
    this.ensureAcieSeeded();

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

      // Legacy feature model (kept for persistence / comparison)
      let legacy: PredictionSignal | null = null;
      if (prior.length >= minHistory) {
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
        signal = {
          predictionId: randomUUID(),
          timestamp: ctx.decisionTimestamp,
          modelVersion: 'acie-v3',
          featureVersion: 'acie-online-1',
          target,
          score: p,
          probability: p,
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
      } else if (legacy) {
        signal = legacy;
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

    const riskResult = this.riskEngine.evaluate(riskInput);

    if (signal) {
      this.persistAsync(signal, ctx, riskResult, target);
    }

    this.logger.info(
      {
        component: 'EntryDecisionService',
        roundId: ctx.roundId,
        approved: riskResult.approved,
        probability: signal?.probability,
        model: signal?.modelVersion,
        acieAction: acieEval?.strategy.action,
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
          regimeName: null,
        });
        await this.predictionRepo.resolveOutcome({
          predictionId: signal.predictionId,
          roundId: ctx.roundId,
          riskApproved: riskResult.approved,
          riskRejectionReason: riskResult.rejectionReason,
          betExecuted: false,
          targetThreshold: target,
        });
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
