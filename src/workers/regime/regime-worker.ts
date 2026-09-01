/**
 * Pattern/Regime Worker — classify market regimes.
 * Design ref: Section 3.3.6
 */

import { BaseWorker } from '../framework/base-worker';
import type { WorkerContext } from '../framework/types';
import { getEventBus } from '../../core/event-bus/bus';

export type RegimeName =
  | 'stable'
  | 'trending_up'
  | 'trending_down'
  | 'volatile'
  | 'chaotic'
  | 'unknown';

export class RegimeWorker extends BaseWorker {
  private points: number[] = [];
  private current: RegimeName = 'unknown';

  constructor(name = 'regime-1') {
    super({
      type: 'regime',
      name,
      priority: 'normal',
      concurrency: 1,
      heartbeatIntervalMs: 10_000,
    });
  }

  getCurrentRegime(): RegimeName {
    return this.current;
  }

  protected async handle(payload: unknown, ctx: WorkerContext): Promise<void> {
    const p = (payload ?? {}) as Record<string, unknown>;
    const crashPoint = Number(p.crashPoint ?? p.multiplier);
    if (!Number.isFinite(crashPoint)) return;

    this.points.push(crashPoint);
    if (this.points.length > 50) this.points.shift();
    if (this.points.length < 8) return;

    const mean = this.points.reduce((a, b) => a + b, 0) / this.points.length;
    const variance =
      this.points.reduce((a, b) => a + (b - mean) ** 2, 0) / this.points.length;
    const recent = this.points.slice(-8);
    const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;

    let next: RegimeName = 'stable';
    if (variance > 8) next = 'chaotic';
    else if (variance > 3) next = 'volatile';
    else if (recentMean > mean * 1.25) next = 'trending_up';
    else if (recentMean < mean * 0.8) next = 'trending_down';
    else next = 'stable';

    if (next !== this.current) {
      const prev = this.current;
      this.current = next;
      const bus = getEventBus();
      await bus.emit({
        id: `regime-${ctx.eventId}`,
        type: 'RegimeChanged' as never,
        payload: {
          previous: prev,
          current: next,
          mean,
          variance,
          sampleSize: this.points.length,
        },
        timestamp: new Date().toISOString(),
        correlationId: ctx.correlationId,
        source: this.name,
      });
    }
  }
}
