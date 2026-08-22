import { BrowserHealthMonitor } from '../../../src/browser/health';
import { Page } from 'playwright';

describe('BrowserHealthMonitor', () => {
  let monitor: BrowserHealthMonitor;
  let mockPage: jest.Mocked<Page>;

  beforeEach(() => {
    monitor = new BrowserHealthMonitor({
      frozenThresholdMs: 5000,
      memoryThresholdMB: 512,
      tickTimeoutMs: 3000,
    });

    mockPage = {
      evaluate: jest.fn(),
    } as unknown as jest.Mocked<Page>;
  });

  afterEach(() => {
    monitor.stop();
  });

  describe('check', () => {
    it('should return healthy metrics for responsive page', async () => {
      mockPage.evaluate.mockResolvedValueOnce({ ok: true, timestamp: Date.now() });
      mockPage.evaluate.mockResolvedValueOnce({
        jsHeapSizeMB: 128,
        domNodeCount: 500,
        wsConnected: true,
      });

      const metrics = await monitor.check(mockPage);

      expect(metrics.pageResponsive).toBe(true);
      expect(metrics.frozen).toBe(false);
      expect(metrics.jsHeapSizeMB).toBe(128);
      expect(metrics.domNodeCount).toBe(500);
      expect(metrics.wsConnected).toBe(true);
      expect(metrics.lastResponseMs).toBeGreaterThanOrEqual(0);
    });

    it('should detect frozen page when evaluate times out', async () => {
      mockPage.evaluate.mockImplementation(() => new Promise(() => {})); // Never resolves

      const metrics = await monitor.check(mockPage);

      expect(metrics.pageResponsive).toBe(false);
      expect(metrics.frozen).toBe(true);
      expect(metrics.wsConnected).toBe(false);
    });

    it('should detect frozen page when evaluate throws', async () => {
      mockPage.evaluate.mockRejectedValue(new Error('Page crashed'));

      const metrics = await monitor.check(mockPage);

      expect(metrics.pageResponsive).toBe(false);
      expect(metrics.frozen).toBe(true);
    });

    it('should detect high memory usage', async () => {
      mockPage.evaluate.mockResolvedValueOnce({ ok: true, timestamp: Date.now() });
      mockPage.evaluate.mockResolvedValueOnce({
        jsHeapSizeMB: 1024,
        domNodeCount: 1000,
        wsConnected: true,
      });

      const degradedEvents: Array<ReturnType<typeof monitor.getLastMetrics>> = [];
      monitor.onDegraded((metrics) => {
        degradedEvents.push(metrics);
      });

      await monitor.check(mockPage);

      expect(degradedEvents.length).toBeGreaterThan(0);
    });
  });

  describe('recordTick', () => {
    it('should update lastTickAt on recordTick', async () => {
      mockPage.evaluate.mockResolvedValueOnce({ ok: true, timestamp: Date.now() });
      mockPage.evaluate.mockResolvedValueOnce({
        jsHeapSizeMB: 100,
        domNodeCount: 100,
        wsConnected: true,
      });

      await monitor.check(mockPage);
      expect(monitor.getLastMetrics()?.lastTickAt).toBeNull();

      monitor.recordTick();

      const metrics = monitor.getLastMetrics();
      expect(metrics?.lastTickAt).not.toBeNull();
    });
  });

  describe('isFrozen', () => {
    it('should return false before any check', () => {
      expect(monitor.isFrozen()).toBe(false);
    });

    it('should return true after frozen detection', async () => {
      mockPage.evaluate.mockRejectedValue(new Error('Timeout'));

      await monitor.check(mockPage);
      expect(monitor.isFrozen()).toBe(true);
    });
  });

  describe('isTickStale', () => {
    it('should return true when no tick recorded', () => {
      expect(monitor.isTickStale()).toBe(true);
    });

    it('should return false after recent tick', async () => {
      mockPage.evaluate.mockResolvedValueOnce({ ok: true, timestamp: Date.now() });
      mockPage.evaluate.mockResolvedValueOnce({
        jsHeapSizeMB: 100,
        domNodeCount: 100,
        wsConnected: true,
      });

      await monitor.check(mockPage);
      monitor.recordTick();

      expect(monitor.isTickStale()).toBe(false);
    });

    it('should return true after tick timeout', async () => {
      // We need to trigger a check first to initialize metrics
      mockPage.evaluate.mockResolvedValueOnce({ ok: true, timestamp: Date.now() });
      mockPage.evaluate.mockResolvedValueOnce({
        jsHeapSizeMB: 100,
        domNodeCount: 100,
        wsConnected: true,
      });

      await monitor.check(mockPage);
      monitor.recordTick();

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 3100));

      expect(monitor.isTickStale()).toBe(true);
    });
  });

  describe('start and stop', () => {
    it('should start periodic health checks', async () => {
      mockPage.evaluate.mockResolvedValue({ ok: true, timestamp: Date.now() });

      monitor.start(mockPage, 100);

      // Wait for at least one check
      await new Promise((resolve) => setTimeout(resolve, 150));

      const metrics = monitor.getLastMetrics();
      expect(metrics).not.toBeNull();

      monitor.stop();
    });

    it('should stop periodic checks', async () => {
      mockPage.evaluate.mockResolvedValue({ ok: true, timestamp: Date.now() });

      monitor.start(mockPage, 50);
      await new Promise((resolve) => setTimeout(resolve, 100));
      monitor.stop();

      const metricsBefore = monitor.getLastMetrics();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const metricsAfter = monitor.getLastMetrics();

      // Metrics should not have changed after stop
      expect(metricsAfter).toEqual(metricsBefore);
    });
  });

  describe('onDegraded', () => {
    it('should call callback when health degrades', async () => {
      const degradedCallback = jest.fn();
      const unsub = monitor.onDegraded(degradedCallback);

      mockPage.evaluate.mockRejectedValue(new Error('Page error'));

      await monitor.check(mockPage);

      expect(degradedCallback).toHaveBeenCalled();
      expect(degradedCallback.mock.calls[0][0].frozen).toBe(true);

      unsub();
    });

    it('should support unsubscribing', async () => {
      const degradedCallback = jest.fn();
      const unsub = monitor.onDegraded(degradedCallback);
      unsub();

      mockPage.evaluate.mockRejectedValue(new Error('Page error'));
      await monitor.check(mockPage);

      // Callback was unsubscribed before check
      expect(degradedCallback).not.toHaveBeenCalled();
    });
  });
});
