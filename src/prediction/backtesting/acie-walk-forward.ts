/**
 * Phase 4.1 — Honest out-of-sample walk-forward on the live ACIE path.
 */

import type { HistoricalRound } from '../types.js';
import { ACIEEngine } from '../acie/engine.js';
import { getLogger } from '../../observability/logger.js';

export interface AcieWalkForwardConfig {
  trainSize: number;
  testSize: number;
  stepSize: number;
  entryThreshold: number;
  target: number;
}

export interface AcieWindowResult {
  windowIndex: number;
  entries: number;
  hits: number;
  precision: number;
  brier: number;
  baselineHitRate: number;
  edgeVsBaseline: number;
}

export interface AcieWalkForwardReport {
  windows: AcieWindowResult[];
  aggregate: {
    entries: number;
    hits: number;
    precision: number;
    meanBrier: number;
    meanEdge: number;
  };
  summary: string;
}

const DEFAULT: AcieWalkForwardConfig = {
  trainSize: 500,
  testSize: 100,
  stepSize: 100,
  entryThreshold: 0.58,
  target: 1.3,
};

export function runAcieWalkForward(
  rounds: HistoricalRound[],
  cfg: Partial<AcieWalkForwardConfig> = {}
): AcieWalkForwardReport {
  const c = { ...DEFAULT, ...cfg };
  const logger = getLogger();
  const windows: AcieWindowResult[] = [];
  let start = 0;

  while (start + c.trainSize + c.testSize <= rounds.length) {
    const train = rounds.slice(start, start + c.trainSize);
    const test = rounds.slice(start + c.trainSize, start + c.trainSize + c.testSize);
    const acie = new ACIEEngine();
    acie.seedHistory(
      train.map((r, i) => ({
        roundId: r.id || r.externalRoundId || `train-${start}-${i}`,
        crashPoint: r.crashPoint,
        timestamp: r.crashedAt ?? r.createdAt,
      }))
    );

    let entries = 0;
    let hits = 0;
    let brierSum = 0;
    let baselineHits = 0;

    for (let i = 0; i < test.length; i++) {
      const r = test[i];
      const evaluation = acie.evaluateNext();
      const p = evaluation.psi?.estimatedProbability ?? 0.65;
      const actual: 0 | 1 = r.crashPoint >= c.target ? 1 : 0;
      baselineHits += actual;
      brierSum += (p - actual) ** 2;
      if (p >= c.entryThreshold) {
        entries += 1;
        hits += actual;
      }
      acie.onCrash({
        roundId: r.id || r.externalRoundId || `test-${start}-${i}`,
        crashPoint: r.crashPoint,
        timestamp: r.crashedAt ?? r.createdAt,
      });
    }

    const precision = entries > 0 ? hits / entries : 0;
    const baselineHitRate = test.length ? baselineHits / test.length : 0;
    windows.push({
      windowIndex: windows.length,
      entries,
      hits,
      precision,
      brier: test.length ? brierSum / test.length : 0,
      baselineHitRate,
      edgeVsBaseline: precision - baselineHitRate,
    });
    start += c.stepSize;
  }

  const totE = windows.reduce((s, w) => s + w.entries, 0);
  const totH = windows.reduce((s, w) => s + w.hits, 0);
  const meanBrier = windows.length
    ? windows.reduce((s, w) => s + w.brier, 0) / windows.length
    : 0;
  const meanEdge = windows.length
    ? windows.reduce((s, w) => s + w.edgeVsBaseline, 0) / windows.length
    : 0;
  const precision = totE > 0 ? totH / totE : 0;
  const report: AcieWalkForwardReport = {
    windows,
    aggregate: { entries: totE, hits: totH, precision, meanBrier, meanEdge },
    summary:
      windows.length === 0
        ? 'INSUFFICIENT_DATA'
        : `ACIE_WF windows=${windows.length} precision=${precision.toFixed(3)} edge=${meanEdge.toFixed(3)} brier=${meanBrier.toFixed(3)}`,
  };
  logger.info({ component: 'AcieWalkForward', ...report.aggregate }, report.summary);
  return report;
}
