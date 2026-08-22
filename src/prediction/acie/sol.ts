/**
 * SOL — Sequential Outcome Learning
 * Rich contextual records for adaptive calibration and feedback.
 */

import {
  ACIE_TARGET,
  SOLRecord,
  SequenceState,
  RegimeLabel,
  PredictionContext,
} from './types.js';

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function logLoss(p: number, actual: 0 | 1): number {
  const eps = 1e-15;
  const q = clamp01(p);
  return actual === 1 ? -Math.log(Math.max(q, eps)) : -Math.log(Math.max(1 - q, eps));
}

export class SequentialOutcomeLearner {
  private readonly records: SOLRecord[] = [];
  private readonly maxInMemory: number;

  constructor(maxInMemory = 5000) {
    this.maxInMemory = maxInMemory;
  }

  /**
   * Record a completed round with the prediction context that was active
   * *before* the outcome was known (caller supplies pre-outcome context).
   */
  record(
    round: { roundId: string; crashPoint: number; timestamp?: string },
    context: PredictionContext
  ): SOLRecord {
    const reached130 = round.crashPoint >= ACIE_TARGET;
    const actual: 0 | 1 = reached130 ? 1 : 0;
    const p = clamp01(context.psiProbability);
    const residual = p - actual;
    const rec: SOLRecord = {
      roundId: round.roundId,
      timestamp: round.timestamp ?? new Date().toISOString(),
      crashPoint: round.crashPoint,
      reached130,
      previousOutcomes: context.history.slice(-20).map((r) => r.crashPoint),
      previousReached130: context.history.slice(-20).map((r) => r.crashPoint >= ACIE_TARGET),
      sequenceState: { ...context.sequenceState },
      regime: context.regime,
      regimeDuration: context.regimeDuration,
      psiProbability: p,
      psiConfidence: context.psiConfidence,
      prediction: context.prediction,
      actualResult: reached130,
      probabilityResidual: residual,
      squaredError: residual * residual,
      logLoss: logLoss(p, actual),
      binnedProbability: Math.floor(p * 10) / 10,
    };
    this.records.push(rec);
    if (this.records.length > this.maxInMemory) {
      this.records.splice(0, this.records.length - this.maxInMemory);
    }
    return rec;
  }

  getRecords(): readonly SOLRecord[] {
    return this.records;
  }

  getRecent(n: number): SOLRecord[] {
    return this.records.slice(-n);
  }

  size(): number {
    return this.records.length;
  }

  /** Seed from historical crash points (no PSI context → baseline residuals). */
  seedFromCrashPoints(
    rounds: Array<{ roundId: string; crashPoint: number; timestamp?: string }>,
    baseState: SequenceState,
    regime: RegimeLabel = 'unknown'
  ): void {
    const baseline =
      rounds.length > 0
        ? rounds.filter((r) => r.crashPoint >= ACIE_TARGET).length / rounds.length
        : 0.65;
    for (let i = 0; i < rounds.length; i++) {
      const hist = rounds.slice(Math.max(0, i - 20), i);
      this.record(rounds[i], {
        history: hist,
        sequenceState: baseState,
        regime,
        regimeDuration: 0,
        psiProbability: baseline,
        psiConfidence: 0.3,
        prediction: false,
      });
    }
  }

  clear(): void {
    this.records.length = 0;
  }
}
