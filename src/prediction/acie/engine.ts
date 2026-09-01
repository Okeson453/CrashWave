/**
 * ACIE v3 Engine — continuous, event-driven adaptation.
 *
 * Every crash is a learning event:
 *   CRASH → RECORD → UPDATE SEQUENCE/REGIME → RE-ESTIMATE P(≥1.30)
 *        → INCREMENTAL CALIBRATION → DRIFT CHECK → NEXT DECISION → wait
 *
 * Heavy batch validation runs on a rolling schedule, not as a prerequisite to decide.
 */

import { SequentialOutcomeLearner } from './sol.js';
import { TemporalPatternLearner } from './tpl.js';
import { PredictiveSequenceIntelligence } from './psi.js';
import { EvidenceEngine } from './evidence.js';
import { SelfAdaptiveForecastingEngine } from './safe.js';
import { StrategyLayer, HIGH_FREQUENCY_STRATEGY_POLICY } from './strategy.js';
import { EntitlementGate } from './entitlement.js';
import {
  applyOnlineUpdate,
  createInitialOnlineState,
  onlineMeanCalibrationError,
  onlineCalibrationBins,
  OnlineAdaptiveState,
} from './online-state.js';
import {
  ACIE_TARGET,
  ACIEEvaluationResult,
  ACIERoundInput,
  EntrySignal,
  EntitlementCheck,
  EntitlementResult,
  EvidenceReport,
  PredictionContext,
  RegimeLabel,
  SequenceState,
  StrategyPolicy,
  StrategyRiskState,
} from './types.js';
import { acieHeavyEvidenceLatencyMs } from '../metrics-acie.js';

export interface ACIEEngineOptions {
  strategyPolicy?: Partial<StrategyPolicy>;
  maxHistory?: number;
  /** Run full SAFE/Evidence batch every N observations (default 50) */
  heavyValidationEvery?: number;
  ewmaAlpha?: number;
}

export interface CrashLearningResult {
  /** Outcome just recorded */
  recordedRoundId: string;
  crashPoint: number;
  reached130: boolean;
  /** Online state after this crash */
  online: OnlineAdaptiveState;
  /** Decision for the *next* round */
  evaluation: ACIEEvaluationResult;
  /** True when heavy batch validation ran this tick */
  heavyValidationRan /* intentionally false on hot tick; heavy runs async */: boolean;
  evidence: EvidenceReport;
}

export class ACIEEngine {
  readonly sol: SequentialOutcomeLearner;
  readonly tpl: TemporalPatternLearner;
  readonly psi: PredictiveSequenceIntelligence;
  readonly evidenceEngine: EvidenceEngine;
  readonly safe: SelfAdaptiveForecastingEngine;
  readonly strategy: StrategyLayer;
  readonly entitlement: EntitlementGate;

  private crashPoints: number[] = [];
  private online: OnlineAdaptiveState = createInitialOnlineState();
  private consecutiveLosses = 0;
  private readonly processedRoundIds = new Set<string>();
  private pendingContext: PredictionContext | null = null;
  private lastEvidence: EvidenceReport | null = null;
  private lastModelProbabilities: Record<string, number> = {};
  private readonly heavyEvery: number;
  private pendingHeavyEvidence = false;
  private heavyEvidenceScheduled = false;
  private readonly evidenceMaxN: number;
  private readonly ewmaAlpha: number;
  private lastRiskState: Partial<StrategyRiskState> = {};

  constructor(opts: ACIEEngineOptions = {}) {
    this.sol = new SequentialOutcomeLearner(opts.maxHistory ?? 5000);
    this.tpl = new TemporalPatternLearner();
    this.psi = new PredictiveSequenceIntelligence(this.tpl);
    this.evidenceEngine = new EvidenceEngine();
    this.safe = new SelfAdaptiveForecastingEngine();
    this.strategy = new StrategyLayer({
      ...HIGH_FREQUENCY_STRATEGY_POLICY,
      ...opts.strategyPolicy,
    });
    this.entitlement = new EntitlementGate();
    this.heavyEvery = opts.heavyValidationEvery ?? 50;
    this.evidenceMaxN = Number(process.env.ACIE_EVIDENCE_MAX_N ?? 1000);
    this.ewmaAlpha = opts.ewmaAlpha ?? 0.05;
  }

  /** Seed historical crashes — each point still goes through lightweight online updates. */
  seedHistory(rounds: ACIERoundInput[]): void {
    for (const r of rounds.slice(-2000)) {
      this.ingestCrash(r, { skipDecision: true });
    }
    // One decision state ready after seed
    this.evaluateNext(this.lastRiskState);
  }

  getSequenceState(): SequenceState {
    return this.tpl.computeSequenceState(this.crashPoints);
  }


  exportSnapshot(): {
    online: OnlineAdaptiveState;
    crashPoints: number[];
    consecutiveLosses: number;
  } {
    return {
      online: { ...this.online },
      crashPoints: this.crashPoints.slice(-2000),
      consecutiveLosses: this.consecutiveLosses,
    };
  }

  importSnapshot(snap: {
    online?: OnlineAdaptiveState;
    crashPoints?: number[];
    consecutiveLosses?: number;
  }): void {
    if (snap.crashPoints?.length) {
      this.seedHistory(
        snap.crashPoints.map((cp, i) => ({
          roundId: `restore-${i}`,
          crashPoint: cp,
          timestamp: new Date().toISOString(),
        }))
      );
    }
    if (snap.online) {
      this.online = { ...snap.online };
    }
    if (typeof snap.consecutiveLosses === 'number') {
      this.consecutiveLosses = snap.consecutiveLosses;
    }
  }

  getOnlineState(): Readonly<OnlineAdaptiveState> {
    return this.online;
  }

  /**
   * Primary event API — call on every completed crash.
   * Learns from the outcome and returns the decision for the next round.
   */
  onCrash(
    round: ACIERoundInput,
    riskState?: Partial<StrategyRiskState>
  ): CrashLearningResult {
    if (riskState) this.lastRiskState = riskState;
    return this.ingestCrash(round, { skipDecision: false, riskState: this.lastRiskState });
  }

  /**
   * Evaluate next opportunity without a new crash (e.g. before first round).
   */
  evaluateNext(riskState?: Partial<StrategyRiskState>): ACIEEvaluationResult {
    if (riskState) this.lastRiskState = riskState;
    return this.buildEvaluation(this.lastRiskState);
  }

  /**
   * Observe a completed round (alias for onCrash without requiring consumer rename).
   */
  observeRound(round: ACIERoundInput, riskState?: Partial<StrategyRiskState>): CrashLearningResult {
    return this.onCrash(round, riskState);
  }

  checkEntitlement(check: EntitlementCheck): EntitlementResult {
    return this.entitlement.check(check);
  }

  produceSignal(
    riskState: Partial<StrategyRiskState>,
    entitlement?: EntitlementCheck
  ): {
    evaluation: ACIEEvaluationResult;
    entitlement: EntitlementResult | null;
    delivered: EntrySignal | null;
  } {
    const evaluation = this.evaluateNext(riskState);
    if (!evaluation.signal) {
      return { evaluation, entitlement: null, delivered: null };
    }
    if (entitlement) {
      const ent = this.checkEntitlement(entitlement);
      if (!ent.allowed) {
        return { evaluation, entitlement: ent, delivered: null };
      }
      return { evaluation, entitlement: ent, delivered: evaluation.signal };
    }
    return { evaluation, entitlement: null, delivered: evaluation.signal };
  }


  /**
   * Cold path: run evidenceEngine.evaluate off the crash tick (setImmediate).
   * Caps history to ACIE_EVIDENCE_MAX_N.
   */
  private scheduleHeavyEvidence(): void {
    if (this.heavyEvidenceScheduled || !this.pendingHeavyEvidence) return;
    this.heavyEvidenceScheduled = true;
    const run = () => {
      this.heavyEvidenceScheduled = false;
      if (!this.pendingHeavyEvidence) return;
      this.pendingHeavyEvidence = false;
      try {
        const t0 = performance.now();
        const all = this.sol.getRecords();
        const capped = (all.length > this.evidenceMaxN ? all.slice(-this.evidenceMaxN) : all).slice();
        this.lastEvidence = this.evidenceEngine.evaluate(capped);
        this.online = {
          ...this.online,
          sinceHeavyValidation: 0,
          lastHeavyValidationAt: this.online.observationCount,
        };
        const ms = performance.now() - t0;
        acieHeavyEvidenceLatencyMs.observe(ms);
      } catch {
        /* keep lastEvidence / lightweight */
      }
    };
    if (typeof setImmediate === 'function') setImmediate(run);
    else setTimeout(run, 0);
  }

  getEvidenceSnapshot(): EvidenceReport {
    if (this.lastEvidence) return this.lastEvidence;
    const all = this.sol.getRecords();
    const capped = (all.length > this.evidenceMaxN ? all.slice(-this.evidenceMaxN) : all).slice();
    return this.evidenceEngine.evaluate(capped);
  }

  getConsecutiveLosses(): number {
    return this.consecutiveLosses;
  }

  historySize(): number {
    return this.crashPoints.length;
  }

  // ─── Internal continuous loop ───────────────────────────────────────────

  private ingestCrash(
    round: ACIERoundInput,
    opts: { skipDecision: boolean; riskState?: Partial<StrategyRiskState> }
  ): CrashLearningResult {
    // Idempotent: ignore duplicate crash events for the same round
    if (round.roundId && this.processedRoundIds.has(round.roundId)) {
      const sequenceState = this.tpl.computeSequenceState(this.crashPoints);
      const regime = this.tpl.detectRegime(sequenceState);
      const evaluation = opts.skipDecision
        ? this.emptyEvaluation(sequenceState, regime)
        : this.buildEvaluation(opts.riskState ?? this.lastRiskState);
      return {
        recordedRoundId: round.roundId,
        crashPoint: round.crashPoint,
        reached130: round.crashPoint >= ACIE_TARGET,
        online: this.online,
        evaluation,
        heavyValidationRan: false,
        evidence: this.lastEvidence ?? this.lightweightEvidence(),
      };
    }
    if (round.roundId) {
      this.processedRoundIds.add(round.roundId);
      if (this.processedRoundIds.size > 5000) {
        const first = this.processedRoundIds.values().next().value as string | undefined;
        if (first) this.processedRoundIds.delete(first);
      }
    }

    if (!Number.isFinite(round.crashPoint) || round.crashPoint <= 0) {
      throw new Error(`ACIE onCrash: invalid crashPoint ${round.crashPoint}`);
    }

    const sequenceStateBefore = this.tpl.computeSequenceState(this.crashPoints);
    const regimeBefore = this.tpl.detectRegime(sequenceStateBefore);

    // 1) RECORD OUTCOME (SOL) using pending prediction context if available
    const ctx: PredictionContext =
      this.pendingContext ??
      ({
        history: this.crashPoints.slice(-20).map((c) => ({ crashPoint: c })),
        sequenceState: sequenceStateBefore,
        regime: regimeBefore,
        regimeDuration: this.online.regimeDuration,
        psiProbability: this.online.lastPsiProbability,
        psiConfidence: 0.3,
        prediction: false,
      } satisfies PredictionContext);

    this.sol.record(round, ctx);

    // 2) UPDATE SEQUENCE + REGIME (TPL) after appending crash
    this.crashPoints.push(round.crashPoint);
    if (this.crashPoints.length > 2000) {
      this.crashPoints = this.crashPoints.slice(-2000);
    }
    const sequenceState = this.tpl.computeSequenceState(this.crashPoints);
    const regime = this.tpl.detectRegime(sequenceState);

    if (round.crashPoint < ACIE_TARGET) this.consecutiveLosses += 1;
    else this.consecutiveLosses = 0;

    // 3) ONLINE ADAPTATION (every crash) — weights, EWMA, calibration buckets, drift
    this.online = applyOnlineUpdate(this.online, {
      crashPoint: round.crashPoint,
      psiProbability: ctx.psiProbability,
      modelProbabilities: this.lastModelProbabilities,
      sequenceState,
      regime,
      alpha: this.ewmaAlpha,
    });

    // 4) Heavy validation — FLAG ONLY on hot path (never O(n) evaluate here)
    let heavyValidationRan = false;
    if (this.online.sinceHeavyValidation >= this.heavyEvery) {
      this.pendingHeavyEvidence = true;
      this.scheduleHeavyEvidence();
    }
    if (!this.lastEvidence) {
      this.lastEvidence = this.lightweightEvidence();
    }

    this.pendingContext = null;

    // 5) GENERATE NEXT SIGNAL (unless seeding)
    const evaluation = opts.skipDecision
      ? this.emptyEvaluation(sequenceState, regime)
      : this.buildEvaluation(opts.riskState ?? this.lastRiskState);

    return {
      recordedRoundId: round.roundId,
      crashPoint: round.crashPoint,
      reached130: round.crashPoint >= ACIE_TARGET,
      online: this.online,
      evaluation,
      heavyValidationRan,
      evidence: this.lastEvidence ?? this.lightweightEvidence(),
    };
  }

  private buildEvaluation(riskState?: Partial<StrategyRiskState>): ACIEEvaluationResult {
    const sequenceState = this.tpl.computeSequenceState(this.crashPoints);
    const regime = this.tpl.detectRegime(sequenceState);
    // Readonly view — no array copy on the hot path
    const history = this.sol.getRecords();

    // Single PSI inference (models + ensemble) — previously ran twice
    const { psi, models } = this.psi.estimateWithModels({
      crashPoints: this.crashPoints,
      sequenceState,
      regime,
      history,
      ensembleWeights: this.online.ensembleWeights,
      ewmaHitRate: this.online.ewmaHitRate,
    });
    this.lastModelProbabilities = Object.fromEntries(
      models.map((m) => [m.modelName, m.probability])
    );

    // Prefer latest heavy evidence; blend calibration error with online estimate
    const evidence = this.lastEvidence ?? this.lightweightEvidence();
    const onlineCalErr = onlineMeanCalibrationError(this.online);
    const calErr = Math.max(evidence.meanCalibrationError, onlineCalErr * 0.5);

    // Drift can degrade effective evidence for strategy without waiting for heavy job
    let evidenceStatus = evidence.status;
    if (this.online.lastDrift.detected && evidenceStatus === 'SUPPORTED') {
      evidenceStatus = 'WEAK';
    } else if (this.online.lastDrift.detected && this.online.observationCount > 100) {
      if (evidenceStatus === 'WEAK') evidenceStatus = 'DEGRADED';
    }

    const fullRisk: StrategyRiskState = {
      currentExposure: riskState?.currentExposure ?? 0,
      consecutiveLosses: riskState?.consecutiveLosses ?? this.consecutiveLosses,
      dailyEntriesUsed: riskState?.dailyEntriesUsed ?? 0,
      dailyEntriesLimit: riskState?.dailyEntriesLimit ?? 500,
      balance: riskState?.balance ?? 0,
    };

    const strategy = this.strategy.evaluate({
      target: ACIE_TARGET,
      probability: psi.estimatedProbability,
      confidenceInterval: psi.confidenceInterval,
      calibrationError: calErr,
      evidence: evidenceStatus,
      regime,
      regimeStability: this.online.regimeDuration,
      uncertainty: {
        model: psi.modelUncertainty,
        data: psi.dataUncertainty,
        total: Math.sqrt(psi.modelUncertainty ** 2 + psi.dataUncertainty ** 2),
      },
      riskState: fullRisk,
      baselineProbability:
        this.online.ewmaHitRate > 0
          ? this.online.ewmaHitRate
          : evidence.baselineProbability > 0
            ? evidence.baselineProbability
            : sequenceState.rolling100HitRate > 0
              ? sequenceState.rolling100HitRate
              : 0.65,
    });

    this.pendingContext = {
      history: this.crashPoints.slice(-20).map((c) => ({ crashPoint: c })),
      sequenceState,
      regime,
      regimeDuration: this.online.regimeDuration,
      psiProbability: psi.estimatedProbability,
      psiConfidence: 1 - Math.min(1, psi.modelUncertainty + psi.dataUncertainty),
      prediction: strategy.isOpportunity,
    };

    let signal: EntrySignal | null = null;
    if (
      strategy.isOpportunity &&
      (strategy.action === 'ENTRY' || strategy.action === 'REDUCED_ENTRY')
    ) {
      signal = {
        target: ACIE_TARGET,
        probability: psi.estimatedProbability,
        confidenceInterval: psi.confidenceInterval,
        evidence: evidenceStatus,
        regime,
        action: strategy.action,
        stake: strategy.stake,
        reason: strategy.reason,
        confidence: strategy.confidence,
        timestamp: new Date().toISOString(),
        psi,
        evidenceReport: { ...evidence, status: evidenceStatus },
      };
    }

    return {
      psi,
      evidence: { ...evidence, status: evidenceStatus },
      strategy,
      signal,
      sequenceState,
      regime,
    };
  }

  private lightweightEvidence(): EvidenceReport {
    const bins = onlineCalibrationBins(this.online).filter((b) => b.sampleSize > 0);
    const meanCal =
      bins.length > 0
        ? bins.reduce((s, b) => s + b.calibrationError * b.sampleSize, 0) /
          bins.reduce((s, b) => s + b.sampleSize, 0)
        : 0.1;
    const n = this.online.observationCount;
    let status: EvidenceReport['status'] = 'INSUFFICIENT';
    if (n >= 500 && !this.online.lastDrift.detected && this.online.ewmaBrier < 0.22) {
      status = 'SUPPORTED';
    } else if (n >= 150 && this.online.ewmaBrier < 0.28) {
      status = 'WEAK';
    } else if (n >= 150 && (this.online.lastDrift.detected || this.online.ewmaBrier > 0.35)) {
      status = 'DEGRADED';
    }
    return {
      status,
      baselineProbability: this.online.ewmaHitRate,
      conditionalImprovement: 0,
      improvementSignificant: false,
      calibrationStatus: meanCal < 0.05 ? 'good' : meanCal < 0.1 ? 'good' : 'poor',
      meanCalibrationError: meanCal,
      performanceTrend: this.online.lastDrift.detected ? 'degrading' : 'stable',
      driftDetected: this.online.lastDrift.detected,
      sampleSize: n,
      sampleAdequate: n >= 500,
      recommendedMode:
        status === 'SUPPORTED' ? 'ACTIVE' : status === 'WEAK' ? 'CAUTIOUS' : 'OBSERVATION',
      reasoning: `Online evidence n=${n} ewmaBrier=${this.online.ewmaBrier.toFixed(3)} drift=${this.online.lastDrift.reason}`,
      calibration: null,
    };
  }

  private emptyEvaluation(
    sequenceState: SequenceState,
    regime: RegimeLabel
  ): ACIEEvaluationResult {
    const evidence = this.lightweightEvidence();
    return {
      psi: {
        target: ACIE_TARGET,
        estimatedProbability: this.online.ewmaHitRate,
        confidenceInterval: [0.5, 0.8],
        sequenceState,
        regime,
        primaryModel: 'FrequencyModel',
        ensembleWeight: 1,
        modelUncertainty: 0.1,
        dataUncertainty: 0.1,
      },
      evidence,
      strategy: {
        action: 'SKIP',
        stake: 0,
        reason: 'seed/warmup',
        confidence: 0,
        isOpportunity: false,
      },
      signal: null,
      sequenceState,
      regime,
    };
  }
}
