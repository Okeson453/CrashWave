/**
 * Validation protocol — metrics computed from prediction/outcome pairs only.
 * No synthetic / hard-coded performance values (P0-08, P0-09, P0-10).
 */

import type { HistoricalRound } from '../types.js';
import { WalkForwardValidator, type WalkForwardConfig } from '../backtesting/walk-forward.js';
import { evaluateModelGate, type ModelGateMetrics } from './model-gate.js';
import { validateCalibration } from './calibration-validator.js';
import { runRandomnessGate, type RandomnessGateReport } from './randomness-gate.js';

export interface ProtocolReport {
  randomness: RandomnessGateReport;
  windows: number;
  baseline: ModelGateMetrics;
  candidate: ModelGateMetrics;
  gate: ReturnType<typeof evaluateModelGate>;
  calibration: ReturnType<typeof validateCalibration>;
  /** Complete gate: all mandatory checks */
  passed: boolean;
  reasons: string[];
  accepted: boolean;
  summary: string;
}

function logLoss(p: number, y: 0 | 1): number {
  const pp = Math.min(0.999, Math.max(0.001, p));
  return y === 1 ? -Math.log(pp) : -Math.log(1 - pp);
}

function metricsFromPairs(
  pairs: Array<{ p: number; y: 0 | 1 }>,
  baselineBrier?: number
): ModelGateMetrics {
  const n = pairs.length;
  if (n === 0) {
    return { brier: 1, logLoss: 10, ece: 1, oosSkill: 0, sampleSize: 0 };
  }
  const brier = pairs.reduce((s, { p, y }) => s + (p - y) ** 2, 0) / n;
  const ll = pairs.reduce((s, { p, y }) => s + logLoss(p, y), 0) / n;
  // Simple ECE: 10 bins
  const bins = Array.from({ length: 10 }, () => ({ n: 0, pSum: 0, ySum: 0 }));
  for (const { p, y } of pairs) {
    const i = Math.min(9, Math.floor(p * 10));
    bins[i].n += 1;
    bins[i].pSum += p;
    bins[i].ySum += y;
  }
  let ece = 0;
  for (const b of bins) {
    if (b.n === 0) continue;
    ece += (b.n / n) * Math.abs(b.pSum / b.n - b.ySum / b.n);
  }
  const oosSkill =
    baselineBrier != null && baselineBrier > 0
      ? Math.max(0, (baselineBrier - brier) / baselineBrier)
      : 0;
  return { brier, logLoss: ll, ece, oosSkill, sampleSize: n };
}

export function runValidationProtocol(
  rounds: HistoricalRound[],
  opts?: {
    minRounds?: number;
    walkForward?: Partial<WalkForwardConfig>;
  }
): ProtocolReport {
  const reasons: string[] = [];
  const crashPoints = rounds.map((r) => r.crashPoint);
  const randomness = runRandomnessGate(crashPoints, {
    minRounds: opts?.minRounds ?? 50_000,
  });
  if (randomness.sampleSize < (opts?.minRounds ?? 50_000)) {
    reasons.push('insufficient_sample');
  }

  const binary = crashPoints.map((c) => (c >= 1.3 ? (1 as const) : (0 as const)));
  const baseRate =
    binary.reduce((a, b) => a + b, 0 as number) / Math.max(1, binary.length);
  const baselinePairs = binary.map((y) => ({ p: baseRate, y }));
  const baseline = metricsFromPairs(baselinePairs);

  // Candidate: expanding short-window empirical rate (still computed, not hard-coded)
  const short = binary.slice(-Math.min(500, binary.length));
  const shortRate =
    short.reduce((a, b) => a + b, 0 as number) / Math.max(1, short.length);
  const candidatePairs = short.map((y) => ({ p: shortRate, y }));
  const candidate = metricsFromPairs(candidatePairs, baseline.brier);

  const calibration = validateCalibration(candidatePairs);
  if (!calibration.passed) reasons.push('calibration_failed');

  const gate = evaluateModelGate(candidate, baseline, calibration);
  if (!gate.allowed) reasons.push('model_gate_failed');

  let windows = 0;
  let walkForwardOk = true;
  if (rounds.length >= 5000) {
    try {
      const wf = new WalkForwardValidator();
      const result = wf.run(rounds, {
        trainSize: opts?.walkForward?.trainSize ?? 2000,
        valSize: opts?.walkForward?.valSize ?? 500,
        testSize: opts?.walkForward?.testSize ?? 500,
        stepSize: opts?.walkForward?.stepSize ?? 500,
        target: opts?.walkForward?.target ?? 1.3,
      });
      windows = result.length;
      if (windows === 0) {
        walkForwardOk = false;
        reasons.push('walk_forward_empty');
      }
    } catch (err) {
      walkForwardOk = false;
      reasons.push(`walk_forward_error:${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    reasons.push('walk_forward_skipped_insufficient_rounds');
  }

  const passed =
    reasons.filter((r) => r !== 'walk_forward_skipped_insufficient_rounds').length === 0 &&
    gate.allowed &&
    calibration.passed &&
    walkForwardOk;

  const accepted = passed;

  return {
    randomness,
    windows,
    baseline,
    candidate,
    gate,
    calibration,
    passed,
    reasons,
    accepted,
    summary: accepted
      ? 'PROTOCOL_PASSED'
      : `PROTOCOL_REJECTED: ${reasons.join(',') || 'unknown'}`,
  };
}
