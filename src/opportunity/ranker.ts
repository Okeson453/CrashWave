/**
 * Centralized Opportunity Ranker — sliding window of scored opportunities.
 * Design ref: Section 10
 */

import { getLogger } from '../observability/logger';
import type { ScoredOpportunity } from './types';

export interface RankerOptions {
  /** Max opportunities retained in the window */
  windowSize?: number;
  /** TTL in ms after which an opportunity expires */
  ttlMs?: number;
  /** Only approve top fraction of scored set (0–1) */
  topFraction?: number;
  /** Absolute minimum quality score to enter ranking */
  minQualityScore?: number;
}

const DEFAULTS = {
  windowSize: 50,
  ttlMs: 60_000,
  topFraction: 0.7,
  minQualityScore: 0.35,
};

export class OpportunityRanker {
  private readonly logger = getLogger();
  private readonly window: ScoredOpportunity[] = [];
  private readonly opts: Required<RankerOptions>;

  constructor(options: RankerOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * Insert/update a scored opportunity and re-rank the window.
   * Returns the opportunity with rank assigned, or null if below min quality.
   */
  upsert(opp: ScoredOpportunity): ScoredOpportunity | null {
    this.evictExpired();
    if (opp.qualityScore < this.opts.minQualityScore) {
      return null;
    }

    const idx = this.window.findIndex((o) => o.id === opp.id);
    if (idx >= 0) {
      this.window[idx] = opp;
    } else {
      this.window.push(opp);
    }

    // Keep newest / highest quality within window size
    this.window.sort((a, b) => b.qualityScore - a.qualityScore);
    while (this.window.length > this.opts.windowSize) {
      this.window.pop();
    }

    // Assign ranks
    this.window.forEach((o, i) => {
      o.rank = i + 1;
    });

    const ranked = this.window.find((o) => o.id === opp.id) ?? null;
    this.logger.debug(
      {
        component: 'OpportunityRanker',
        opportunityId: opp.id,
        qualityScore: opp.qualityScore,
        rank: ranked?.rank,
        windowSize: this.window.length,
      },
      'Opportunity ranked'
    );
    return ranked;
  }

  /** Top-N opportunities currently in window */
  top(n: number = 10): ScoredOpportunity[] {
    this.evictExpired();
    return this.window.slice(0, n).map((o) => ({ ...o }));
  }

  /**
   * Whether this opportunity is within the approve-able top fraction.
   */
  isApproved(opportunityId: string): boolean {
    this.evictExpired();
    const opp = this.window.find((o) => o.id === opportunityId);
    if (!opp || opp.rank == null) return false;
    const cutoff = Math.max(1, Math.ceil(this.window.length * this.opts.topFraction));
    return opp.rank <= cutoff;
  }

  size(): number {
    this.evictExpired();
    return this.window.length;
  }

  clear(): void {
    this.window.length = 0;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (let i = this.window.length - 1; i >= 0; i--) {
      if (new Date(this.window[i].expiresAt).getTime() < now) {
        this.window.splice(i, 1);
      }
    }
  }
}
