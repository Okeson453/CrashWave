/**
 * Velocity & rate controller — limits action frequency to reduce bot-like patterns.
 */

import { VelocityConfig } from '../config/schema';
import { getLogger } from '../observability/logger';
import { metricCollector } from '../observability/metrics/collectors';

interface ActionRecord {
  timestamp: number;
  type: string;
}

export interface VelocityDecision {
  allowed: boolean;
  waitMs: number;
  reason?: string;
}

export class VelocityController {
  private readonly logger = getLogger();
  private history: ActionRecord[] = [];
  private lastActionAt = 0;

  constructor(private readonly config: VelocityConfig) {}

  /**
   * Call before any sensitive action (bet placement, cash-out, etc.).
   */
  async acquire(actionType: string): Promise<VelocityDecision> {
    if (!this.config.enabled) {
      return { allowed: true, waitMs: 0 };
    }

    const now = Date.now();
    this.prune(now);

    const lastMinute = this.history.filter((h) => now - h.timestamp < 60_000).length;
    const lastHour = this.history.filter((h) => now - h.timestamp < 3_600_000).length;

    if (lastMinute >= this.config.maxActionsPerMinute) {
      const oldestInWindow = this.history
        .filter((h) => now - h.timestamp < 60_000)
        .sort((a, b) => a.timestamp - b.timestamp)[0];
      const waitMs = oldestInWindow
        ? Math.max(1000, 60_000 - (now - oldestInWindow.timestamp))
        : 60_000;
      return { allowed: false, waitMs, reason: 'maxActionsPerMinute' };
    }
    if (lastHour >= this.config.maxActionsPerHour) {
      return { allowed: false, waitMs: 30_000, reason: 'maxActionsPerHour' };
    }

    const elapsed = now - this.lastActionAt;
    const minInterval = this.randomBetween(
      this.config.minActionIntervalMs,
      this.config.maxActionIntervalMs
    );

    if (this.lastActionAt > 0 && elapsed < minInterval) {
      return { allowed: false, waitMs: minInterval - elapsed, reason: 'minInterval' };
    }

    if (Math.random() < this.config.idleProbability) {
      const idleMs = this.randomBetween(this.config.minIdleMs, this.config.maxIdleMs);
      this.logger.info({ component: 'VelocityController', idleMs, actionType }, 'Inserting human idle period');
      (metricCollector as any).recordVelocityIdle?.(idleMs);
      return { allowed: false, waitMs: idleMs, reason: 'humanIdle' };
    }

    return { allowed: true, waitMs: 0 };
  }

  /** Wait until acquire allows, then return (optional helper for callers) */
  async waitUntilAllowed(actionType: string, maxWaitMs = 300_000): Promise<VelocityDecision> {
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const decision = await this.acquire(actionType);
      if (decision.allowed) return decision;
      const sleepMs = Math.min(decision.waitMs, maxWaitMs - (Date.now() - started));
      if (sleepMs <= 0) break;
      await new Promise((r) => setTimeout(r, sleepMs));
    }
    return { allowed: false, waitMs: 0, reason: 'maxWaitExceeded' };
  }

  record(actionType: string): void {
    const now = Date.now();
    this.history.push({ timestamp: now, type: actionType });
    this.lastActionAt = now;
    (metricCollector as any).recordVelocityAction?.(actionType);
  }

  getCashOutJitter(): number {
    if (!this.config.enabled) return 0;
    return Math.floor(Math.random() * (this.config.cashOutJitterMs + 1));
  }

  private prune(now: number): void {
    const cutoff = now - 3_600_000;
    this.history = this.history.filter((h) => h.timestamp >= cutoff);
  }

  private randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}
