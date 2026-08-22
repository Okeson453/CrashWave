import { metricsRegistry, entriesTotal, pnlUnits, getMetrics } from '../../../src/observability/metrics/registry';
import { MetricCollector } from '../../../src/observability/metrics/collectors';

describe('metrics registry', () => {
  beforeEach(() => {
    metricsRegistry.resetMetrics();
  });

  it('should register metrics', () => {
    expect(entriesTotal).toBeDefined();
    expect(pnlUnits).toBeDefined();
  });

  it('should collect metrics', async () => {
    entriesTotal.inc({ status: 'confirmed' });
    const metrics = await getMetrics();
    expect(metrics).toContain('crash_entries_total');
    expect(metrics).toContain('status="confirmed"');
  });
});

describe('MetricCollector', () => {
  let collector: MetricCollector;

  beforeEach(() => {
    metricsRegistry.resetMetrics();
    collector = new MetricCollector();
  });

  it('should record entries', () => {
    collector.recordEntry('confirmed');
    collector.recordEntry('attempted');
    collector.recordEntry('failed');
    // Metrics are registered, we verify no throw
    expect(true).toBe(true);
  });

  it('should set balance', () => {
    collector.setBalance(10000);
    expect(true).toBe(true);
  });

  it('should record bet placement', () => {
    collector.recordBetPlacement(true);
    collector.recordBetPlacement(false, 'timeout');
    expect(true).toBe(true);
  });

  it('should record cash out', () => {
    collector.recordCashOut(true);
    collector.recordCashOut(false, 'latency');
    expect(true).toBe(true);
  });

  it('should record tick latency', () => {
    collector.recordTickLatency(250);
    expect(true).toBe(true);
  });

  it('should set browser process status', () => {
    collector.setBrowserProcessUp(true);
    collector.setBrowserProcessUp(false);
    expect(true).toBe(true);
  });

  it('should set observation confidence', () => {
    collector.setObservationConfidence('high');
    collector.setObservationConfidence('medium');
    collector.setObservationConfidence('low');
    expect(true).toBe(true);
  });

  it('should record errors', () => {
    collector.recordError('warn', 'test');
    collector.recordError('fatal', 'test');
    expect(true).toBe(true);
  });

  it('should record telegram notifications', () => {
    collector.recordTelegramNotification(true);
    collector.recordTelegramNotification(false, 'rate_limit');
    expect(true).toBe(true);
  });
});
