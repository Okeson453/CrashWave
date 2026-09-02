/**
 * Incremental feature tracker — thin adapter over IncrementalStateEngine.
 * Critical path: O(1), zero DB I/O.
 */

import type { HistoricalRound } from '../types.js';
import {
  IncrementalStateEngine,
  globalIncrementalState,
  type IncrementalEngineSnapshot,
} from '../state/incremental-state-engine.js';
import { featureHotCache } from '../../observability/performance/hot-cache.js';
import { featureLatencyMs } from '../../observability/performance/latency.js';

export type IncrementalState = IncrementalEngineSnapshot;

export class IncrementalFeatureTracker {
  constructor(private readonly engine: IncrementalStateEngine = globalIncrementalState) {}

  seed(rounds: HistoricalRound[]): void {
    this.engine.seed(rounds.map((r) => r.crashPoint));
    featureHotCache.set('latest', this.toFeatures(), 60_000);
  }

  onCrash(crashPoint: number): Record<string, number> {
    const t0 = performance.now();
    this.engine.update(crashPoint);
    const features = this.toFeatures();
    featureHotCache.set('latest', features, 15_000);
    featureLatencyMs.observe(performance.now() - t0);
    return features;
  }

  toFeatures(): Record<string, number> {
    const e = this.engine;
    const snap = e.snapshot();
    const mean = snap.welford.mean;
    const variance = e.variance();
    return {
      n: snap.count,
      mean_cp: mean,
      var_cp: variance,
      std_cp: Math.sqrt(variance),
      last_cp: snap.lastCrash ?? 0,
      last10_mean: e.shortMean(),
      streak_below_15: snap.runs.below15,
      streak_above_20: snap.runs.above20,
      streak_below_13: snap.runs.below13,
      streak_above_13: snap.runs.above13,
      hit_rate_13: e.hitRate(1.3),
      hit_rate_20: e.hitRate(2.0),
      hit_rate_50: e.hitRate(5.0),
      ewma_cp: snap.ewma,
      ewma_hit_13: snap.ewmaHit13,
      short_hit_13: e.shortHitRate13(),
      markov_p13: e.markovPNextAbove13(),
      quality_score: Math.min(1, snap.count / 100),
    };
  }

  getState(): Readonly<IncrementalEngineSnapshot> {
    return this.engine.snapshot();
  }

  getEngine(): IncrementalStateEngine {
    return this.engine;
  }
}

export const globalIncrementalFeatures = new IncrementalFeatureTracker();
