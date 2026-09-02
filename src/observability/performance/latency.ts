/**
 * V1.1 latency instrumentation — critical-path stage timings.
 * Targets (design §1.4): entry p99 < 300ms, prediction p99 < 50ms.
 */

import { Histogram, Counter, Gauge } from 'prom-client';
import { metricsRegistry } from '../metrics/registry.js';

/** Stage latencies in ms */
export const stageLatencyMs = new Histogram({
  name: 'crash_stage_latency_ms',
  help: 'Latency of pipeline stages in milliseconds',
  labelNames: ['stage'],
  buckets: [1, 2, 5, 10, 20, 35, 50, 75, 100, 150, 200, 300, 500, 1000, 2000],
  registers: [metricsRegistry],
});

/** End-to-end detection → entry decision */
export const entryPathLatencyMs = new Histogram({
  name: 'crash_entry_path_latency_ms',
  help: 'End-to-end entry path latency (detect → decision) in ms',
  buckets: [10, 25, 50, 75, 100, 150, 200, 300, 500, 800, 1200, 2000],
  registers: [metricsRegistry],
});

export const predictionLatencyMs = new Histogram({
  name: 'crash_prediction_latency_ms',
  help: 'Prediction / ACIE evaluateNext latency in ms',
  buckets: [1, 2, 5, 10, 20, 35, 50, 75, 100, 200, 400],
  registers: [metricsRegistry],
});

export const featureLatencyMs = new Histogram({
  name: 'crash_feature_latency_ms',
  help: 'Feature computation latency in ms',
  buckets: [1, 2, 5, 10, 20, 50, 100, 200],
  registers: [metricsRegistry],
});

export const riskLatencyMs = new Histogram({
  name: 'crash_risk_latency_ms',
  help: 'Risk engine evaluation latency in ms',
  buckets: [0.5, 1, 2, 5, 10, 20, 50],
  registers: [metricsRegistry],
});

export const decisionLatencyMs = new Histogram({
  name: 'crash_decision_latency_ms',
  help: 'V1.1 DecisionEngine latency in ms',
  buckets: [0.5, 1, 2, 5, 10, 20, 50],
  registers: [metricsRegistry],
});

export const cacheHitTotal = new Counter({
  name: 'crash_cache_hit_total',
  help: 'Hot cache hits on critical path',
  labelNames: ['cache'],
  registers: [metricsRegistry],
});

export const cacheMissTotal = new Counter({
  name: 'crash_cache_miss_total',
  help: 'Hot cache misses on critical path',
  labelNames: ['cache'],
  registers: [metricsRegistry],
});

export const entryPathP99Gauge = new Gauge({
  name: 'crash_entry_path_p99_estimate_ms',
  help: 'Rolling estimate of entry path p99 latency',
  registers: [metricsRegistry],
});

export type LatencyStage =
  | 'history'
  | 'prediction'
  | 'feature'
  | 'risk'
  | 'decision'
  | 'entry_total'
  | 'legacy_shadow';

export class LatencyTimer {
  private readonly start: number;
  private marks = new Map<string, number>();

  constructor() {
    this.start = performance.now();
  }

  mark(name: string): void {
    this.marks.set(name, performance.now());
  }

  /** Elapsed ms since construct or since mark */
  elapsed(sinceMark?: string): number {
    const base = sinceMark && this.marks.has(sinceMark) ? this.marks.get(sinceMark)! : this.start;
    return performance.now() - base;
  }

  record(stage: LatencyStage, sinceMark?: string): number {
    const ms = this.elapsed(sinceMark);
    stageLatencyMs.observe({ stage }, ms);
    switch (stage) {
      case 'prediction':
        predictionLatencyMs.observe(ms);
        break;
      case 'feature':
        featureLatencyMs.observe(ms);
        break;
      case 'risk':
        riskLatencyMs.observe(ms);
        break;
      case 'decision':
        decisionLatencyMs.observe(ms);
        break;
      case 'entry_total':
        entryPathLatencyMs.observe(ms);
        break;
      default:
        break;
    }
    return ms;
  }
}

/** Rolling window for p99 estimate (in-process) */
export class RollingLatencyWindow {
  private samples: number[] = [];
  private readonly max: number;

  constructor(max = 200) {
    this.max = max;
  }

  push(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > this.max) this.samples.shift();
    entryPathP99Gauge.set(this.p99());
  }

  p50(): number {
    return this.percentile(0.5);
  }

  p95(): number {
    return this.percentile(0.95);
  }

  p99(): number {
    return this.percentile(0.99);
  }

  count(): number {
    return this.samples.length;
  }

  private percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx];
  }
}

export const globalEntryLatencyWindow = new RollingLatencyWindow(500);
