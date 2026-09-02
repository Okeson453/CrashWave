/**
 * Sliding opportunity window for ranking / analytics.
 */

import type { OpportunityRecord } from './opportunity-ranker.js';

export class OpportunityWindow {
  private readonly items: OpportunityRecord[] = [];
  constructor(private readonly maxSize = 500) {}

  push(rec: OpportunityRecord): void {
    this.items.push(rec);
    if (this.items.length > this.maxSize) this.items.shift();
  }

  active(now = Date.now()): OpportunityRecord[] {
    return this.items.filter((r) => new Date(r.expiry).getTime() > now);
  }

  top(n = 10, now = Date.now()): OpportunityRecord[] {
    return this.active(now)
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}

export const globalOpportunityWindow = new OpportunityWindow();
