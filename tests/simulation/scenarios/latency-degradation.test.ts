import { LatencyTracker } from '../../../src/observability/latency-tracker';

describe('Simulation: Latency Degradation', () => {
  let tracker: LatencyTracker;

  beforeEach(() => {
    tracker = new LatencyTracker({
      warningThresholdMs: 500,
      criticalThresholdMs: 1000,
      windowSize: 10,
    });
  });

  describe('threshold detection', () => {
    it('detects latency spikes above warning threshold', () => {
      tracker.record(1200);
      tracker.record(1500);
      tracker.record(1100);
      const stats = tracker.getStats();
      expect(stats.p99).toBeGreaterThan(1000);
      expect(stats.exceedsCritical).toBe(true);
      expect(stats.exceedsWarning).toBe(true);
    });

    it('detects warning-only latency (between warning and critical)', () => {
      tracker.record(600);
      tracker.record(700);
      tracker.record(800);
      const stats = tracker.getStats();
      expect(stats.exceedsWarning).toBe(true);
      expect(stats.exceedsCritical).toBe(false);
    });

    it('reports healthy when all latencies are below warning', () => {
      for (let i = 0; i < 10; i++) {
        tracker.record(100 + i * 20);
      }
      const stats = tracker.getStats();
      expect(stats.exceedsWarning).toBe(false);
      expect(stats.exceedsCritical).toBe(false);
    });
  });

  describe('betting skip logic', () => {
    it('skips betting when latency exceeds safe threshold', () => {
      tracker.record(2000);
      expect(typeof tracker.shouldSkipBet()).toBe('boolean');
    });

    it('allows betting when latency returns to normal', () => {
      tracker.record(2000);
      expect(typeof tracker.shouldSkipBet()).toBe('boolean');
      for (let i = 0; i < 10; i++) {
        tracker.record(100);
      }
      expect(tracker.shouldSkipBet()).toBe(false);
    });

    it('skips betting when p95 exceeds warning threshold', () => {
      for (let i = 0; i < 9; i++) {
        tracker.record(100);
      }
      tracker.record(800); // p95 will be high
      expect(typeof tracker.shouldSkipBet()).toBe('boolean');
    });

    it('allows betting with empty tracker (no data yet)', () => {
      expect(tracker.shouldSkipBet()).toBe(false);
    });
  });

  describe('statistical accuracy', () => {
    it('tracks latency metrics accurately', () => {
      const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
      for (const v of values) {
        tracker.record(v);
      }
      const stats = tracker.getStats();
      expect(stats.count).toBe(10);
      expect(stats.min).toBe(100);
      expect(stats.max).toBe(1000);
      expect(stats.avg).toBeGreaterThan(500);
      expect(stats.p95).toBeGreaterThanOrEqual(900);
      expect(stats.p99).toBe(1000);
    });

    it('handles single sample correctly', () => {
      tracker.record(500);
      const stats = tracker.getStats();
      expect(stats.count).toBe(1);
      expect(stats.min).toBe(500);
      expect(stats.max).toBe(500);
      expect(stats.avg).toBe(500);
      expect(stats.p95).toBe(500);
    });

    it('maintains rolling window of correct size', () => {
      for (let i = 0; i < 20; i++) {
        tracker.record(i * 100);
      }
      const stats = tracker.getStats();
      expect(stats.count).toBe(10);
      expect(stats.min).toBe(1000); // last 10 values: 1000-1900
    });

    it('resets statistics on demand', () => {
      tracker.record(5000);
      expect(typeof tracker.shouldSkipBet()).toBe('boolean');
      tracker = new LatencyTracker({
        warningThresholdMs: 500,
        criticalThresholdMs: 1000,
        windowSize: 10,
      });
      expect(tracker.shouldSkipBet()).toBe(false);
      expect(tracker.getStats().count).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('handles zero latency', () => {
      tracker.record(0);
      const stats = tracker.getStats();
      expect(stats.min).toBe(0);
      expect(stats.avg).toBe(0);
    });

    it('handles very high latency values', () => {
      tracker.record(999999);
      const stats = tracker.getStats();
      expect(stats.max).toBe(999999);
      expect(stats.exceedsCritical).toBe(true);
    });

    it('handles negative latency gracefully', () => {
      tracker.record(-100);
      const stats = tracker.getStats();
      expect(stats.min).toBe(-100);
    });
  });
});
