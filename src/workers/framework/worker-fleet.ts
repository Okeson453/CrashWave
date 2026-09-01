import { getLogger } from '../../observability/logger';
import { BaseWorker } from './base-worker';
import type { WorkerHealth, WorkerType } from './types';

export interface FleetSnapshot { workers: Array<{ name: string; type: WorkerType | string; health: WorkerHealth }>; running: number; degraded: number; failed: number; }

export class WorkerFleet {
  private readonly logger = getLogger();
  private readonly workers = new Map<string, BaseWorker>();
  private readonly restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private supervisionTimer: ReturnType<typeof setInterval> | null = null;
  private supervising = false;

  register(worker: BaseWorker): void {
    if (this.workers.has(worker.name)) throw new Error(`Worker already registered: ${worker.name}`);
    this.workers.set(worker.name, worker);
  }

  async startAll(): Promise<void> {
    const results = await Promise.allSettled([...this.workers.values()].map((w) => w.start()));
    results.forEach((r, i) => { if (r.status === 'rejected') this.logger.error({ component: 'WorkerFleet', worker: [...this.workers.keys()][i], error: String(r.reason) }, 'Worker failed to start'); });
    this.startSupervision();
  }

  async stopAll(): Promise<void> {
    this.supervising = false;
    if (this.supervisionTimer) clearInterval(this.supervisionTimer);
    this.supervisionTimer = null;
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    await Promise.allSettled([...this.workers.values()].reverse().map((w) => w.stop()));
  }

  get(name: string): BaseWorker | undefined { return this.workers.get(name); }
  snapshot(): FleetSnapshot {
    const workers = [...this.workers.values()].map((worker) => ({ name: worker.name, type: worker.type, health: worker.getHealth() }));
    return { workers, running: workers.filter((w) => w.health.status === 'running').length, degraded: workers.filter((w) => w.health.status === 'degraded').length, failed: workers.filter((w) => w.health.status === 'failed').length };
  }
  hasCriticalFailure(criticalTypes: string[] = ['discovery', 'prediction', 'execution', 'monitoring']): boolean {
    return [...this.workers.values()].some((w) => w.getHealth().status === 'failed' && criticalTypes.includes(w.type));
  }

  private startSupervision(): void {
    if (this.supervising) return;
    this.supervising = true;
    this.supervisionTimer = setInterval(() => { void this.supervise(); }, 1_000);
    this.supervisionTimer.unref?.();
  }

  private async supervise(): Promise<void> {
    if (!this.supervising) return;
    for (const worker of this.workers.values()) {
      if (worker.getHealth().status !== 'failed') continue;
      if (!worker.autoRestartEnabled) continue;
      if (this.restartTimers.has(worker.name)) continue;
      const delay = worker.restartBackoffMs;
      const timer = setTimeout(async () => {
        this.restartTimers.delete(worker.name);
        try {
          await worker.stop().catch(() => undefined);
          worker.markRestarted();
          await worker.start();
          this.logger.warn({ component: 'WorkerFleet', worker: worker.name }, 'Worker automatically restarted');
        } catch (err) {
          this.logger.error({ component: 'WorkerFleet', worker: worker.name, error: String(err) }, 'Worker restart failed');
        }
      }, delay);
      this.restartTimers.set(worker.name, timer);
    }
  }
}
