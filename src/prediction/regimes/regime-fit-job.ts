
/**
 * Offline learned-regime fit — train-only features, never uses test labels for scaler.
 */

import { globalLearnedRegimes, type LearnedClusteringModel } from "./learned-clustering.js";
import { getLogger } from "../../observability/logger.js";

const logger = getLogger();

export interface RegimeFitInput {
  /** Chronological feature rows (train segment only) */
  featureRows: number[][];
  /** Aligned binary outcomes for cluster hit rates */
  outcomes: number[];
  k?: number;
  version?: string;
}

export function runRegimeFitJob(input: RegimeFitInput): LearnedClusteringModel {
  if (input.featureRows.length < 100) {
    throw new Error(`Regime fit needs ≥100 rows, got ${input.featureRows.length}`);
  }
  const model = globalLearnedRegimes.fit(
    input.featureRows,
    input.outcomes,
    input.k ?? 8,
    input.version ?? `regime-kmeans-${Date.now()}`
  );
  logger.info(
    {
      component: "RegimeFitJob",
      k: model.k,
      version: model.version,
      samples: input.featureRows.length,
    },
    "Learned regimes fitted"
  );
  return model;
}

/** Build simple 8-d feature rows from crash points for offline fit */
export function featureRowsFromCrashPoints(points: number[]): {
  rows: number[][];
  outcomes: number[];
} {
  const rows: number[][] = [];
  const outcomes: number[] = [];
  let ewma = 0.65;
  let runBelow = 0;
  let runAbove = 0;
  for (let i = 0; i < points.length; i++) {
    const cp = points[i];
    const hit = cp >= 1.3 ? 1 : 0;
    ewma = 0.05 * hit + 0.95 * ewma;
    if (hit) {
      runAbove += 1;
      runBelow = 0;
    } else {
      runBelow += 1;
      runAbove = 0;
    }
    if (i < 20) continue;
    const window = points.slice(Math.max(0, i - 20), i);
    const shortHit = window.filter((x) => x >= 1.3).length / window.length;
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const m2 = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
    rows.push([ewma, mean, runBelow, runAbove, shortHit, shortHit, mean, Math.sqrt(m2)]);
    outcomes.push(hit);
  }
  return { rows, outcomes };
}
