/**
 * Cross-process financial circuit breaker (Redis-backed when available).
 * Opens when consecutive financial failures exceed threshold.
 */

import { getLogger } from '../../observability/logger.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class FinancialCircuitBreaker {
  private readonly logger = getLogger();
  private failures = 0;
  private state: CircuitState = 'CLOSED';
  private openedAt = 0;
  private readonly threshold: number;
  private readonly coolDownMs: number;
  private redis: { get: (k: string) => Promise<string | null>; set: (k: string, v: string, ...args: unknown[]) => Promise<unknown> } | null = null;
  private readonly key: string;

  constructor(opts?: {
    threshold?: number;
    coolDownMs?: number;
    redis?: FinancialCircuitBreaker['redis'];
    key?: string;
  }) {
    this.threshold = opts?.threshold ?? 5;
    this.coolDownMs = opts?.coolDownMs ?? 60_000;
    this.redis = opts?.redis ?? null;
    this.key = opts?.key ?? 'crash:financial-circuit';
  }

  async isOpen(): Promise<boolean> {
    await this.hydrate();
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt >= this.coolDownMs) {
        this.state = 'HALF_OPEN';
        await this.persist();
        return false;
      }
      return true;
    }
    return false;
  }

  async recordSuccess(): Promise<void> {
    this.failures = 0;
    this.state = 'CLOSED';
    await this.persist();
  }

  async recordFailure(reason?: string): Promise<void> {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      this.logger.error(
        { component: 'FinancialCircuitBreaker', failures: this.failures, reason },
        'Financial circuit OPEN'
      );
    }
    await this.persist();
  }

  snapshot(): { state: CircuitState; failures: number } {
    return { state: this.state, failures: this.failures };
  }

  private async hydrate(): Promise<void> {
    if (!this.redis) return;
    try {
      const raw = await this.redis.get(this.key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { state: CircuitState; failures: number; openedAt: number };
      this.state = parsed.state;
      this.failures = parsed.failures;
      this.openedAt = parsed.openedAt;
    } catch { /* */ }
  }

  private async persist(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(
        this.key,
        JSON.stringify({ state: this.state, failures: this.failures, openedAt: this.openedAt }),
        'EX',
        3600
      );
    } catch { /* */ }
  }
}

export const globalFinancialCircuitBreaker = new FinancialCircuitBreaker();
