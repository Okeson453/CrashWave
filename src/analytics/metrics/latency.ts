/**
 * Latency Metrics — Observation & Execution Latency Analysis
 *
 * Computes latency percentiles (p50, p95, p99), tracks degradation trends,
 * and detects latency spikes. Operates on LatencySample records.
 */

import { LatencyMetrics, LatencySample } from '../types';
import { classifyLatencyTrend, LATENCY_THRESHOLDS } from '../constants';

/**
 * Compute latency metrics from an array of latency samples.
 *
 * @param samples — array of LatencySample records
 * @returns LatencyMetrics with percentiles and trend analysis
 */
export function computeLatencyMetrics(samples: LatencySample[]): LatencyMetrics {
  if (samples.length === 0) {
    return emptyLatencyMetrics();
  }

  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);

  const observationSamples = samples.filter((s) => s.type === 'observation');
  const executionSamples = samples.filter((s) => s.type === 'execution');
  const cashoutSamples = samples.filter((s) => s.type === 'cashout');

  return {
    observationLatencyMs: computeAverage(observationSamples.map((s) => s.latencyMs)),
    executionLatencyMs: computeAverage(executionSamples.map((s) => s.latencyMs)),
    cashoutLatencyMs: computeAverage(cashoutSamples.map((s) => s.latencyMs)),
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    max: latencies[latencies.length - 1],
    min: latencies[0],
    sampleCount: samples.length,
    degradationTrend: classifyLatencyTrend(percentile(latencies, 0.95)),
  };
}

/**
 * Compute latency metrics for a specific type only.
 *
 * @param samples — array of LatencySample records
 * @param type — latency type to filter by
 * @returns LatencyMetrics for the specified type
 */
export function computeLatencyMetricsByType(
  samples: LatencySample[],
  type: 'observation' | 'execution' | 'cashout'
): LatencyMetrics {
  const filtered = samples.filter((s) => s.type === type);
  return computeLatencyMetrics(filtered);
}

/**
 * Detect latency degradation by comparing recent samples against
 * a baseline window.
 *
 * @param recentSamples — most recent latency samples
 * @param baselineSamples — historical baseline samples
 * @param thresholdMultiplier — multiplier above baseline to flag (default 2.0)
 * @returns true if recent latency is significantly degraded
 */
export function detectLatencyDegradation(
  recentSamples: LatencySample[],
  baselineSamples: LatencySample[],
  thresholdMultiplier: number = 2.0
): boolean {
  if (recentSamples.length < 5 || baselineSamples.length < 10) {
    return false;
  }

  const recentP95 = percentile(
    recentSamples.map((s) => s.latencyMs).sort((a, b) => a - b),
    0.95
  );

  const baselineP95 = percentile(
    baselineSamples.map((s) => s.latencyMs).sort((a, b) => a - b),
    0.95
  );

  if (baselineP95 === 0) {
    return recentP95 > LATENCY_THRESHOLDS.degraded;
  }

  return recentP95 > baselineP95 * thresholdMultiplier;
}

/**
 * Detect a latency spike — a sudden increase in the most recent samples.
 *
 * @param samples — array of latency samples (chronological order)
 * @param spikeThresholdMs — absolute threshold in ms (default 1000)
 * @param consecutiveCount — number of consecutive high-latency samples (default 3)
 * @returns true if a spike is detected
 */
export function detectLatencySpike(
  samples: LatencySample[],
  spikeThresholdMs: number = LATENCY_THRESHOLDS.degraded,
  consecutiveCount: number = 3
): boolean {
  if (samples.length < consecutiveCount) return false;

  const recent = samples.slice(-consecutiveCount);
  return recent.every((s) => s.latencyMs >= spikeThresholdMs);
}

/**
 * Compute the percentile of a sorted array.
 *
 * Uses linear interpolation between ranks.
 */
function percentile(sortedArray: number[], p: number): number {
  if (sortedArray.length === 0) return 0;
  if (sortedArray.length === 1) return sortedArray[0];

  const index = p * (sortedArray.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (upper >= sortedArray.length) return sortedArray[lower];

  return sortedArray[lower] * (1 - weight) + sortedArray[upper] * weight;
}

/**
 * Compute the average of an array of numbers.
 */
function computeAverage(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Compute the standard deviation of an array of numbers.
 */
export function computeStandardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = computeAverage(values);
  const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Compute a rolling window of latency metrics.
 *
 * @param samples — all latency samples
 * @param windowSize — number of samples per window
 * @returns array of LatencyMetrics for each window
 */
export function computeRollingLatencyMetrics(
  samples: LatencySample[],
  windowSize: number = 50
): LatencyMetrics[] {
  const results: LatencyMetrics[] = [];

  for (let i = windowSize; i <= samples.length; i += windowSize / 2) {
    const window = samples.slice(Math.max(0, i - windowSize), i);
    results.push(computeLatencyMetrics(window));
  }

  return results;
}

/**
 * Return an empty latency metrics object.
 */
function emptyLatencyMetrics(): LatencyMetrics {
  return {
    observationLatencyMs: 0,
    executionLatencyMs: 0,
    cashoutLatencyMs: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    max: 0,
    min: 0,
    sampleCount: 0,
    degradationTrend: 'improving',
  };
}

/**
 * Format latency metrics for human-readable display.
 */
export function formatLatencyMetrics(metrics: LatencyMetrics): string {
  const lines = [
    `Observation Latency: ${metrics.observationLatencyMs.toFixed(1)} ms`,
    `Execution Latency:   ${metrics.executionLatencyMs.toFixed(1)} ms`,
    `Cashout Latency:     ${metrics.cashoutLatencyMs.toFixed(1)} ms`,
    `P50:                 ${metrics.p50.toFixed(1)} ms`,
    `P95:                 ${metrics.p95.toFixed(1)} ms`,
    `P99:                 ${metrics.p99.toFixed(1)} ms`,
    `Min/Max:             ${metrics.min.toFixed(1)} / ${metrics.max.toFixed(1)} ms`,
    `Samples:             ${metrics.sampleCount}`,
    `Trend:               ${metrics.degradationTrend}`,
  ];

  return lines.join('\n');
}
