/**
 * LatencyTracker monitors tick observation latency.
 * Alerts when latency exceeds safe thresholds.
 */

export interface LatencyStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  exceedsCritical: boolean;
  exceedsWarning: boolean;
}

export interface LatencyTrackerOptions {
  warningThresholdMs: number;
  criticalThresholdMs: number;
  windowSize: number;
}

export class LatencyTracker {
  private readonly warningThresholdMs: number;
  private readonly criticalThresholdMs: number;
  private readonly windowSize: number;
  private latencies: number[] = [];

  constructor(options: LatencyTrackerOptions) {
    this.warningThresholdMs = options.warningThresholdMs;
    this.criticalThresholdMs = options.criticalThresholdMs;
    this.windowSize = options.windowSize;
  }

  record(latencyMs: number): void {
    this.latencies.push(latencyMs);
    if (this.latencies.length > this.windowSize) {
      this.latencies.shift();
    }
  }

  getStats(): LatencyStats {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) {
      return {
        count: 0,
        min: 0,
        max: 0,
        avg: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        exceedsCritical: false,
        exceedsWarning: false,
      };
    }

    const percentile = (p: number): number => {
      const idx = Math.ceil((p / 100) * n) - 1;
      return sorted[Math.max(0, Math.min(idx, n - 1))];
    };

    const avg = sorted.reduce((a, b) => a + b, 0) / n;
    const p99 = percentile(99);

    return {
      count: n,
      min: sorted[0],
      max: sorted[n - 1],
      avg,
      p50: percentile(50),
      p95: percentile(95),
      p99,
      exceedsCritical: p99 > this.criticalThresholdMs,
      exceedsWarning: p99 > this.warningThresholdMs,
    };
  }

  shouldSkipBet(): boolean {
    return this.getStats().exceedsCritical;
  }
}
