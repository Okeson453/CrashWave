/**
 * Production worker primitive.
 * - bounded concurrency
 * - FIFO queue per worker
 * - graceful drain
 * - retry handled by caller/queue, never silently swallowed
 * - accurate windowed metrics
 */
import { getLogger } from '../../observability/logger';
import type { WorkerConfig, WorkerContext, WorkerHealth, WorkerStatus, WorkerMetrics } from './types';
import { DEFAULT_WORKER_CONFIG } from './types';

interface WorkItem { payload: unknown; ctx: WorkerContext; resolve: () => void; reject: (e: unknown) => void; }

export abstract class BaseWorker {
  protected readonly logger = getLogger();
  protected readonly config: WorkerConfig;
  protected status: WorkerStatus = 'stopped';
  protected processedCount = 0;
  protected errorCount = 0;
  protected consecutiveErrors = 0;
  protected restartCount = 0;
  protected lastHeartbeatAt = new Date().toISOString();
  protected lastEventAt: string | null = null;
  protected latencies: number[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private accepting = false;
  private active = 0;
  private readonly pending: WorkItem[] = [];
  private readonly metricWindow: Array<{ at: number; ok: boolean; latency: number }> = [];

  constructor(partial: Partial<WorkerConfig> & Pick<WorkerConfig, 'type' | 'name'>) {
    this.config = { ...DEFAULT_WORKER_CONFIG, ...partial, concurrency: Math.max(1, partial.concurrency ?? DEFAULT_WORKER_CONFIG.concurrency) };
  }

  get type(): string { return this.config.type; }
  get name(): string { return this.config.name; }
  get isRunning(): boolean { return this.running; }
  get pendingDepth(): number { return this.pending.length; }
  get autoRestartEnabled(): boolean { return this.config.autoRestart; }
  get restartBackoffMs(): number { return this.config.restartBackoffMs; }

  async start(): Promise<void> {
    if (this.running) return;
    this.status = 'starting';
    try {
      await this.onStart();
      this.running = true;
      this.accepting = true;
      this.status = 'running';
      this.startHeartbeat();
      this.logger.info({ component: 'Worker', worker: this.name, type: this.type }, 'Worker running');
    } catch (err) {
      this.status = 'failed';
      this.running = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.running && this.status === 'stopped') return;
    this.accepting = false;
    this.status = 'stopping';
    this.stopHeartbeat();
    try {
      await this.onStop();
      await this.drain();
    } finally {
      this.running = false;
      this.status = 'stopped';
    }
  }

  /** Queue work and enforce configured concurrency. */
  async process(payload: unknown, ctx: WorkerContext): Promise<void> {
    if (!this.running || !this.accepting || this.status === 'failed') {
      throw new Error(`Worker ${this.name} is not accepting work`);
    }
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ payload, ctx, resolve, reject });
      this.pump();
    });
  }

  getHealth(): WorkerHealth {
    return {
      status: this.status,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastEventAt: this.lastEventAt,
      processedCount: this.processedCount,
      errorCount: this.errorCount,
      restartCount: this.restartCount,
      latencyMsP99: this.computeP99(),
      message: this.status === 'failed' ? 'Consecutive error threshold exceeded' : null,
    };
  }

  getMetrics(): WorkerMetrics {
    this.pruneMetrics();
    const now = Date.now();
    const avg = this.metricWindow.length === 0 ? 0 : this.metricWindow.reduce((a, x) => a + x.latency, 0) / this.metricWindow.length;
    const errors = this.metricWindow.filter((x) => !x.ok).length;
    return {
      throughputPerMinute: this.metricWindow.filter((x) => now - x.at <= 60_000).length,
      errorRate: this.metricWindow.length === 0 ? 0 : errors / this.metricWindow.length,
      avgLatencyMs: avg,
      queueDepth: this.pending.length + this.active,
    };
  }

  protected async onStart(): Promise<void> {}
  protected async onStop(): Promise<void> {}
  protected abstract handle(payload: unknown, ctx: WorkerContext): Promise<void>;

  /** Used by WorkerFleet after a supervised restart. */
  markRestarted(): void { this.restartCount += 1; }

  private pump(): void {
    while (this.active < this.config.concurrency && this.pending.length > 0 && this.running) {
      const item = this.pending.shift()!;
      this.active += 1;
      void this.run(item);
    }
  }

  private async run(item: WorkItem): Promise<void> {
    const start = Date.now();
    try {
      await this.handle(item.payload, item.ctx);
      this.processedCount += 1;
      this.consecutiveErrors = 0;
      this.lastEventAt = new Date().toISOString();
      this.recordLatency(Date.now() - start);
      this.metricWindow.push({ at: Date.now(), ok: true, latency: Date.now() - start });
      item.resolve();
    } catch (err) {
      this.errorCount += 1;
      this.consecutiveErrors += 1;
      this.metricWindow.push({ at: Date.now(), ok: false, latency: Date.now() - start });
      if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) this.status = 'failed';
      item.reject(err);
    } finally {
      this.active -= 1;
      this.pump();
    }
  }

  private async drain(): Promise<void> {
    while (this.active > 0 || this.pending.length > 0) {
      if (this.pending.length > 0 && !this.running) {
        const pending = this.pending.splice(0);
        for (const item of pending) item.reject(new Error(`Worker ${this.name} stopped before processing`));
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => { this.lastHeartbeatAt = new Date().toISOString(); }, this.config.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }
  private stopHeartbeat(): void { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } }
  private recordLatency(ms: number): void { this.latencies.push(ms); if (this.latencies.length > 500) this.latencies.shift(); }
  private computeP99(): number | null {
    if (this.latencies.length < 5) return null;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  }
  private pruneMetrics(): void { const cutoff = Date.now() - 300_000; while (this.metricWindow[0] && this.metricWindow[0].at < cutoff) this.metricWindow.shift(); }
}
