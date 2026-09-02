/**
 * §8 Learned regime clustering — k-means on normalized feature vectors.
 * Scaler is versioned and fitted only on training data.
 */

import type { RegimeClusterState } from './regime-state.js';

export interface ScalerParams {
  version: string;
  means: number[];
  stds: number[];
}

export interface LearnedClusteringModel {
  version: string;
  k: number;
  centroids: number[][];
  scaler: ScalerParams;
  clusterHitRates: number[];
  clusterCounts: number[];
  labels: string[];
}

function euclidean(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

export function fitStandardScaler(rows: number[][], version = 'scaler-v1'): ScalerParams {
  if (rows.length === 0) return { version, means: [], stds: [] };
  const dim = rows[0].length;
  const means = new Array(dim).fill(0);
  const stds = new Array(dim).fill(1);
  for (const r of rows) {
    for (let j = 0; j < dim; j++) means[j] += r[j];
  }
  for (let j = 0; j < dim; j++) means[j] /= rows.length;
  for (const r of rows) {
    for (let j = 0; j < dim; j++) stds[j] += (r[j] - means[j]) ** 2;
  }
  for (let j = 0; j < dim; j++) {
    stds[j] = Math.sqrt(stds[j] / Math.max(1, rows.length - 1)) || 1;
  }
  return { version, means, stds };
}

export function transform(row: number[], scaler: ScalerParams): number[] {
  return row.map((v, i) => (v - (scaler.means[i] ?? 0)) / (scaler.stds[i] ?? 1));
}

export function kMeans(
  rows: number[][],
  k: number,
  maxIter = 40
): { centroids: number[][]; assignments: number[] } {
  const n = rows.length;
  if (n === 0) return { centroids: [], assignments: [] };
  const dim = rows[0].length;
  const kk = Math.min(k, n);
  // Init: spread indices
  const centroids: number[][] = [];
  for (let i = 0; i < kk; i++) {
    centroids.push([...rows[Math.floor((i * n) / kk)]]);
  }
  const assignments = new Array(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const d = euclidean(rows[i], centroids[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }
    const sums = Array.from({ length: kk }, () => new Array(dim).fill(0));
    const counts = new Array(kk).fill(0);
    for (let i = 0; i < n; i++) {
      const a = assignments[i];
      counts[a]++;
      for (let j = 0; j < dim; j++) sums[a][j] += rows[i][j];
    }
    for (let c = 0; c < kk; c++) {
      if (counts[c] === 0) continue;
      for (let j = 0; j < dim; j++) centroids[c][j] = sums[c][j] / counts[c];
    }
    if (!changed) break;
  }
  return { centroids, assignments };
}

const DEFAULT_LABELS = [
  'cluster-0',
  'cluster-1',
  'cluster-2',
  'cluster-3',
  'cluster-4',
  'cluster-5',
  'cluster-6',
  'cluster-7',
];

export class LearnedRegimeClustering {
  private model: LearnedClusteringModel | null = null;
  private lastCluster = -1;
  private duration = 0;

  fit(
    featureRows: number[][],
    outcomes: number[],
    k = 8,
    version = 'regime-kmeans-v1'
  ): LearnedClusteringModel {
    const scaler = fitStandardScaler(featureRows);
    const normalized = featureRows.map((r) => transform(r, scaler));
    const { centroids, assignments } = kMeans(normalized, k);
    const clusterCounts = new Array(centroids.length).fill(0);
    const clusterHits = new Array(centroids.length).fill(0);
    for (let i = 0; i < assignments.length; i++) {
      const a = assignments[i];
      clusterCounts[a]++;
      clusterHits[a] += outcomes[i] ?? 0;
    }
    const clusterHitRates = clusterCounts.map((c, i) => (c > 0 ? clusterHits[i] / c : 0.65));
    this.model = {
      version,
      k: centroids.length,
      centroids,
      scaler,
      clusterHitRates,
      clusterCounts,
      labels: DEFAULT_LABELS.slice(0, centroids.length),
    };
    return this.model;
  }

  isFitted(): boolean {
    return this.model != null;
  }

  getModel(): LearnedClusteringModel | null {
    return this.model;
  }

  load(model: LearnedClusteringModel): void {
    this.model = model;
  }

  assign(featureRow: number[]): RegimeClusterState {
    if (!this.model || this.model.centroids.length === 0) {
      return {
        clusterId: -1,
        clusterDistance: 0,
        clusterConfidence: 0,
        regimeDuration: 0,
        transitionProbability: 0,
        sampleCount: 0,
        historicalHitRate: 0.65,
        historicalCalibration: 0,
        label: 'unfitted',
      };
    }
    const x = transform(featureRow, this.model.scaler);
    let best = 0;
    let bestD = Infinity;
    let second = Infinity;
    for (let c = 0; c < this.model.centroids.length; c++) {
      const d = euclidean(x, this.model.centroids[c]);
      if (d < bestD) {
        second = bestD;
        bestD = d;
        best = c;
      } else if (d < second) {
        second = d;
      }
    }
    if (best === this.lastCluster) this.duration += 1;
    else {
      this.lastCluster = best;
      this.duration = 1;
    }
    const conf = second > 0 ? 1 - bestD / (second + 1e-9) : 1;
    return {
      clusterId: best,
      clusterDistance: bestD,
      clusterConfidence: Math.max(0, Math.min(1, conf)),
      regimeDuration: this.duration,
      transitionProbability: this.duration <= 1 ? 0.5 : 1 / this.duration,
      sampleCount: this.model.clusterCounts[best] ?? 0,
      historicalHitRate: this.model.clusterHitRates[best] ?? 0.65,
      historicalCalibration: 0,
      label: this.model.labels[best] ?? `cluster-${best}`,
    };
  }
}

export const globalLearnedRegimes = new LearnedRegimeClustering();
