/**
 * Performance Analytics Worker — metrics aggregation hooks.
 * Design ref: Section 3.3.14
 */

import { BaseWorker } from '../framework/base-worker';
import type { WorkerContext } from '../framework/types';

export interface AnalyticsWorkerDeps {
  onMetrics?: (payload: Record<string, unknown>) => Promise<void>;
}

export class AnalyticsWorker extends BaseWorker {
  private readonly deps: AnalyticsWorkerDeps;
  private entries = 0;
  private wins = 0;
  private pnl = 0;

  constructor(deps: AnalyticsWorkerDeps = {}, name = 'analytics-1') {
    super({
      type: 'analytics',
      name,
      priority: 'background',
      concurrency: 1,
      heartbeatIntervalMs: 30_000,
    });
    this.deps = deps;
  }

  protected async handle(payload: unknown, _ctx: WorkerContext): Promise<void> {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (p.type === 'entry' || p.event === 'entry') this.entries += 1;
    if (p.won === true || p.outcome === 'win') this.wins += 1;
    if (typeof p.pnl === 'number') this.pnl += p.pnl;

    const summary = {
      entries: this.entries,
      wins: this.wins,
      hitRate: this.entries > 0 ? this.wins / this.entries : 0,
      pnl: this.pnl,
      updatedAt: new Date().toISOString(),
    };

    if (this.deps.onMetrics) await this.deps.onMetrics(summary);
  }

  getSummary() {
    return {
      entries: this.entries,
      wins: this.wins,
      hitRate: this.entries > 0 ? this.wins / this.entries : 0,
      pnl: this.pnl,
    };
  }
}
