import { Page } from 'playwright';
import { BrowserHealthMetrics } from './types';
import { getLogger } from '../observability/logger';
import { withTimeout } from '../utils/async';

export interface BrowserHealthOptions {
  frozenThresholdMs: number;
  memoryThresholdMB: number;
  tickTimeoutMs: number;
}

export class BrowserHealthMonitor {
  private readonly options: BrowserHealthOptions;
  private readonly logger = getLogger();
  private lastMetrics: BrowserHealthMetrics | null = null;
  /** Independent tick timestamp so early ticks before first metrics still count */
  private lastTickAtIso: string | null = null;
  private lastCheckAt: number = 0;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private onDegradedCallbacks: Array<(metrics: BrowserHealthMetrics) => void> = [];

  constructor(options: Partial<BrowserHealthOptions> = {}) {
    this.options = {
      frozenThresholdMs: options.frozenThresholdMs ?? 5000,
      memoryThresholdMB: options.memoryThresholdMB ?? 512,
      tickTimeoutMs: options.tickTimeoutMs ?? 3000,
    };
  }

  onDegraded(callback: (metrics: BrowserHealthMetrics) => void): () => void {
    this.onDegradedCallbacks.push(callback);
    return () => {
      const idx = this.onDegradedCallbacks.indexOf(callback);
      if (idx >= 0) this.onDegradedCallbacks.splice(idx, 1);
    };
  }

  private emitDegraded(metrics: BrowserHealthMetrics): void {
    for (const cb of this.onDegradedCallbacks) {
      try {
        cb(metrics);
      } catch (err) {
        this.logger.warn({ component: 'BrowserHealth', error: String(err) }, 'Degraded callback error');
      }
    }
  }

  /**
   * Start periodic health checks.
   */
  start(page: Page, intervalMs: number = 5000): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(async () => {
      try {
        await this.check(page);
      } catch (error) {
        this.logger.warn(
          { component: 'BrowserHealth', error: String(error) },
          'Health check failed'
        );
      }
    }, intervalMs);

    this.logger.info(
      { component: 'BrowserHealth', intervalMs },
      'Browser health monitoring started'
    );
  }

  /**
   * Stop periodic health checks.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      this.logger.info({ component: 'BrowserHealth' }, 'Browser health monitoring stopped');
    }
  }

  /**
   * Perform a single health check on the page.
   */
  async check(page: Page): Promise<BrowserHealthMetrics> {
    const checkStart = Date.now();

    try {
      // Check page responsiveness with a lightweight evaluate
      const responsive = await withTimeout(
        page.evaluate(() => ({ ok: true, timestamp: Date.now() })),
        this.options.frozenThresholdMs,
        'Page responsiveness check timed out'
      );

      const responseTime = Date.now() - checkStart;

      // Gather memory and DOM metrics
      const metrics = await withTimeout(
        page.evaluate(() => {
          const perf = (window as unknown as Window & { performance: Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } } }).performance;
          const memory = perf.memory;
          return {
            jsHeapSizeMB: memory ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : 0,
            domNodeCount: document.querySelectorAll('*').length,
            wsConnected: (() => {
              // Check if any WebSocket is in OPEN state
              const wsList = (window as unknown as Window & { __wsList?: WebSocket[] }).__wsList;
              if (wsList && wsList.length > 0) {
                return wsList.some((ws) => ws.readyState === WebSocket.OPEN);
              }
              // Fallback: check global ws if exposed
              const globalWs = (window as unknown as Window & { ws?: WebSocket }).ws;
              return globalWs ? globalWs.readyState === WebSocket.OPEN : false;
            })(),
          };
        }),
        3000,
        'Metrics collection timed out'
      );

      // Determine if page is frozen (no response or extremely slow)
      const frozen = responseTime > this.options.frozenThresholdMs;

      // Determine if memory is over threshold
      const memoryOverThreshold = metrics.jsHeapSizeMB > this.options.memoryThresholdMB;

      const result: BrowserHealthMetrics = {
        pageResponsive: responsive.ok && !frozen,
        lastResponseMs: responseTime,
        memoryUsageMB: metrics.jsHeapSizeMB,
        jsHeapSizeMB: metrics.jsHeapSizeMB,
        domNodeCount: metrics.domNodeCount,
        wsConnected: metrics.wsConnected,
        lastTickAt: this.lastMetrics?.lastTickAt || null,
        frozen,
      };

      this.lastMetrics = result;
      this.lastCheckAt = Date.now();

      if (frozen || memoryOverThreshold || !result.pageResponsive) {
        this.emitDegraded(result);
        this.logger.warn(
          {
            component: 'BrowserHealth',
            frozen,
            memoryOverThreshold,
            responseTime,
            jsHeapMB: metrics.jsHeapSizeMB,
          },
          'Browser health degraded'
        );
      } else {
        this.logger.debug(
          {
            component: 'BrowserHealth',
            responseTime,
            jsHeapMB: metrics.jsHeapSizeMB,
            domNodes: metrics.domNodeCount,
            wsConnected: metrics.wsConnected,
          },
          'Browser health OK'
        );
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BrowserHealth', error: message }, 'Health check failed');

      const result: BrowserHealthMetrics = {
        pageResponsive: false,
        lastResponseMs: Date.now() - checkStart,
        memoryUsageMB: this.lastMetrics?.memoryUsageMB ?? 0,
        jsHeapSizeMB: this.lastMetrics?.jsHeapSizeMB ?? 0,
        domNodeCount: this.lastMetrics?.domNodeCount ?? 0,
        wsConnected: false,
        lastTickAt: this.lastMetrics?.lastTickAt || null,
        frozen: true,
      };

      this.lastMetrics = result;
      this.emitDegraded(result);
      return result;
    }
  }

  /**
   * Record that a multiplier tick was received (for stale detection).
   */
  recordTick(): void {
    const now = new Date().toISOString();
    this.lastTickAtIso = now;
    if (this.lastMetrics) {
      this.lastMetrics.lastTickAt = now;
    }
  }

  /**
   * Check if the page appears frozen based on last metrics.
   */
  isFrozen(): boolean {
    return this.lastMetrics?.frozen ?? false;
  }

  /**
   * Check if the last tick was too long ago.
   */
  isTickStale(): boolean {
    const tickAt = this.lastTickAtIso ?? this.lastMetrics?.lastTickAt;
    if (!tickAt) return true;
    const elapsed = Date.now() - new Date(tickAt).getTime();
    return elapsed > this.options.tickTimeoutMs;
  }

  /**
   * Get the most recent health metrics.
   */
  getLastMetrics(): BrowserHealthMetrics | null {
    return this.lastMetrics;
  }

  /**
   * Get time since last health check.
   */
  getTimeSinceLastCheck(): number {
    return Date.now() - this.lastCheckAt;
  }
}
