/**
 * HistoricalDataService — centralized access to historical crash rounds.
 *
 * PostgreSQL/TimescaleDB is the authoritative source.
 * Live prediction reads from RollingHistoryBuffer (memory).
 * Range/research queries still hit the database.
 */

import { RoundRepository, RoundRecord } from '../persistence/repositories/round-repo.js';
import { getLogger } from '../observability/logger.js';
import { HistoricalRound } from './types.js';
import { RollingHistoryBuffer } from './rolling-history-buffer.js';

const QUALITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export class HistoricalDataService {
  private readonly logger = getLogger();
  private readonly roundRepo: RoundRepository;
  private readonly buffer: RollingHistoryBuffer;
  private warmPromise: Promise<void> | null = null;

  constructor(roundRepo?: RoundRepository, bufferMaxSize = 200) {
    this.roundRepo = roundRepo ?? new RoundRepository();
    this.buffer = new RollingHistoryBuffer(bufferMaxSize);
  }

  getBuffer(): RollingHistoryBuffer {
    return this.buffer;
  }

  toHistorical(record: RoundRecord, sequenceIndex?: number): HistoricalRound | null {
    const crashPoint = record.finalConfirmedCrashPoint ?? record.observedCrashPoint ?? null;
    if (crashPoint == null || !Number.isFinite(crashPoint) || crashPoint <= 0) return null;
    return {
      id: record.id,
      externalRoundId: record.externalRoundId,
      sessionId: record.sessionId,
      startedAt: record.startedAt,
      crashedAt: record.crashedAt,
      crashPoint,
      observationSource: record.observationSource,
      dataQuality: (record.dataQuality as HistoricalRound['dataQuality']) ?? null,
      createdAt: record.createdAt,
      sequenceIndex,
    };
  }

  /**
   * Warm the rolling buffer from PostgreSQL once (or force re-warm).
   * Safe to call concurrently — only one warm runs at a time.
   */
  async ensureWarmed(limit = 200, force = false): Promise<void> {
    if (this.buffer.isWarmed() && !force) return;
    if (this.warmPromise && !force) {
      await this.warmPromise;
      return;
    }
    this.warmPromise = this.loadAndWarm(limit);
    try {
      await this.warmPromise;
    } finally {
      this.warmPromise = null;
    }
  }

  private async loadAndWarm(limit: number): Promise<void> {
    const records = await this.roundRepo.findRecentCompleted(limit);
    const chronological = [...records].reverse();
    const out: HistoricalRound[] = [];
    chronological.forEach((r, i) => {
      const h = this.toHistorical(r, i);
      if (h) out.push(h);
    });
    this.buffer.warm(out);
    this.logger.info(
      { component: 'HistoricalDataService', loaded: out.length },
      'Rolling history warmed from database'
    );
  }

  /**
   * Live path: read from memory only (after warm).
   * Falls back to a one-shot DB load if buffer is cold.
   */
  async getRecentRounds(limit = 100): Promise<HistoricalRound[]> {
    if (!this.buffer.isWarmed()) {
      await this.ensureWarmed(Math.max(limit, 200));
    }
    return this.buffer.getPrior(limit);
  }

  /**
   * Synchronous memory read for the critical prediction path.
   * Returns empty if not yet warmed — caller should ensureWarmed at startup.
   */
  getRecentRoundsSync(
    limit = 100,
    excludeRoundId?: string,
    excludeExternalId?: string | null
  ): HistoricalRound[] {
    return this.buffer.getPrior(limit, excludeRoundId, excludeExternalId);
  }

  /**
   * Append a completed round into the rolling buffer (no DB read).
   */
  onRoundCompleted(round: HistoricalRound): void {
    this.buffer.append(round);
  }

  onRoundRecordCompleted(record: RoundRecord): void {
    const h = this.toHistorical(record);
    if (h) this.buffer.append(h);
  }

  async getRoundsInRange(fromIso: string, toIso: string, limit = 5000): Promise<HistoricalRound[]> {
    const records = await this.roundRepo.findCompletedInRange(fromIso, toIso, limit);
    const out: HistoricalRound[] = [];
    records.forEach((r, i) => {
      const h = this.toHistorical(r, i);
      if (h) out.push(h);
    });
    this.logger.debug(
      { component: 'HistoricalDataService', from: fromIso, to: toIso, count: out.length },
      'Loaded historical window from DB'
    );
    return out;
  }

  async getRollingWindow(size: number): Promise<HistoricalRound[]> {
    return this.getRecentRounds(size);
  }

  filterByQuality(
    rounds: HistoricalRound[],
    minQuality: 'high' | 'medium' | 'low' = 'low'
  ): HistoricalRound[] {
    const minRank = QUALITY_RANK[minQuality] ?? 1;
    return rounds.filter((r) => {
      if (!r.dataQuality) return minRank <= 1;
      return (QUALITY_RANK[r.dataQuality] ?? 0) >= minRank;
    });
  }
}
