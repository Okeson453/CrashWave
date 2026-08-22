/**
 * RollingHistoryBuffer — bounded in-memory window of completed crash rounds.
 *
 * PostgreSQL remains the authoritative source. This buffer is warmed once
 * (or periodically) from the DB and then updated on each completed round.
 * Live prediction reads only from memory — no per-entry SQL.
 */

import { HistoricalRound } from './types.js';
import { getLogger } from '../observability/logger.js';

export class RollingHistoryBuffer {
  private readonly logger = getLogger();
  private readonly maxSize: number;
  /** Chronological ascending (oldest → newest) */
  private rounds: HistoricalRound[] = [];
  private warmed = false;
  private lastWarmAt: string | null = null;

  constructor(maxSize = 200) {
    this.maxSize = Math.max(10, maxSize);
  }

  isWarmed(): boolean {
    return this.warmed;
  }

  size(): number {
    return this.rounds.length;
  }

  getLastWarmAt(): string | null {
    return this.lastWarmAt;
  }

  /**
   * Replace buffer contents from a DB load (chronological ascending expected).
   */
  warm(rounds: HistoricalRound[]): void {
    // Ensure chronological ascending
    const sorted = [...rounds].sort((a, b) => {
      const ta = new Date(a.crashedAt ?? a.createdAt).getTime();
      const tb = new Date(b.crashedAt ?? b.createdAt).getTime();
      return ta - tb;
    });
    // Keep only the most recent maxSize
    this.rounds = sorted.slice(-this.maxSize);
    this.reindex();
    this.warmed = true;
    this.lastWarmAt = new Date().toISOString();
    this.logger.info(
      { component: 'RollingHistoryBuffer', size: this.rounds.length, maxSize: this.maxSize },
      'History buffer warmed'
    );
  }

  /**
   * Append a newly completed round. Evicts oldest when over capacity.
   * Idempotent on id / externalRoundId.
   */
  append(round: HistoricalRound): void {
    if (this.rounds.some((r) => r.id === round.id || r.externalRoundId === round.externalRoundId)) {
      return;
    }
    this.rounds.push(round);
    if (this.rounds.length > this.maxSize) {
      this.rounds = this.rounds.slice(this.rounds.length - this.maxSize);
    }
    this.reindex();
  }

  /**
   * Snapshot of prior rounds for prediction (chronological ascending).
   * Optionally excludes a live/current round id that must not leak into features.
   */
  getPrior(limit?: number, excludeRoundId?: string, excludeExternalId?: string | null): HistoricalRound[] {
    let view = this.rounds;
    if (excludeRoundId || excludeExternalId) {
      view = view.filter(
        (r) =>
          r.id !== excludeRoundId &&
          (excludeExternalId == null || r.externalRoundId !== excludeExternalId)
      );
    }
    if (limit != null && limit < view.length) {
      return view.slice(-limit);
    }
    return view.slice();
  }

  /** Full chronological snapshot (copy). */
  snapshot(): HistoricalRound[] {
    return this.rounds.slice();
  }

  clear(): void {
    this.rounds = [];
    this.warmed = false;
    this.lastWarmAt = null;
  }

  private reindex(): void {
    this.rounds.forEach((r, i) => {
      r.sequenceIndex = i;
    });
  }
}
