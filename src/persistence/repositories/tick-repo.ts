import { Pool } from 'pg';
import { getLogger } from '../../observability/logger';
import { CriticalError } from '../../utils/errors';
import { getPool } from '../client';

export interface TickRecord {
  time: string;
  roundId: string | null;
  multiplier: number;
  source: string | null;
  latencyMs: number | null;
  sessionId: string | null;
}

export interface CreateTickInput {
  roundId?: string | null;
  multiplier: number;
  observedAt?: string;
  source?: string | null;
  latencyMs?: number | null;
  sessionId?: string | null;
}

/**
 * TickRepository provides optimized insertion and querying of multiplier ticks
 * in TimescaleDB. Uses hypertable for high-frequency time-series data.
 *
 * Insertion is optimized for speed with minimal overhead.
 * Queries support time-range filtering and aggregation.
 */
export class TickRepository {
  private readonly logger = getLogger();
  private pool: Pool;
  private batchBuffer: CreateTickInput[] = [];
  private batchSize: number;
  private batchFlushIntervalMs: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pool?: Pool, batchSize: number = 100, batchFlushIntervalMs: number = 1000) {
    this.pool = pool || getPool();
    this.batchSize = batchSize;
    this.batchFlushIntervalMs = batchFlushIntervalMs;
  }

  /**
   * Start automatic batch flushing.
   */
  startBatching(): void {
    if (this.flushTimer) return;

    this.flushTimer = setInterval(() => {
      if (this.batchBuffer.length > 0) {
        this.flushBatch().catch((err) => {
          this.logger.error(
            { component: 'TickRepository', error: String(err) },
            'Auto batch flush failed'
          );
        });
      }
    }, this.batchFlushIntervalMs);

    this.logger.info(
      { component: 'TickRepository', batchSize: this.batchSize, flushIntervalMs: this.batchFlushIntervalMs },
      'Tick batching started'
    );
  }

  /**
   * Stop automatic batch flushing and flush remaining items.
   */
  async stopBatching(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.batchBuffer.length > 0) {
      await this.flushBatch();
    }

    this.logger.info({ component: 'TickRepository' }, 'Tick batching stopped');
  }

  /**
   * Insert a single tick. If batching is active, adds to buffer.
   */
  async insert(input: CreateTickInput): Promise<void> {
    if (this.flushTimer) {
      this.batchBuffer.push(input);
      if (this.batchBuffer.length >= this.batchSize) {
        await this.flushBatch();
      }
      return;
    }

    await this.insertSingle(input);
  }

  /**
   * Insert a single tick directly (no batching).
   */
  private async insertSingle(input: CreateTickInput): Promise<void> {
    const query = `
      INSERT INTO multiplier_ticks (time, round_id, multiplier, source, latency_ms, session_id)
      VALUES (NOW(), $1, $2, $3, $4, $5)
    `;

    try {
      await this.pool.query(query, [
        input.roundId ?? null,
        input.multiplier,
        input.source ?? null,
        input.latencyMs ?? null,
        input.sessionId ?? null,
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'TickRepository', error: message }, 'Failed to insert tick');
      throw new CriticalError(`Tick insertion failed: ${message}`, 'TICK_INSERT_FAILED');
    }
  }

  /**
   * Flush the batch buffer in a single transaction.
   */
  async flushBatch(): Promise<number> {
    if (this.batchBuffer.length === 0) return 0;

    const batch = [...this.batchBuffer];
    this.batchBuffer = [];

    // Single multi-row INSERT — one round-trip for the whole batch
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let param = 1;
    for (const input of batch) {
      placeholders.push(
        `($${param++}, $${param++}, $${param++}, $${param++}, $${param++}, $${param++})`
      );
      values.push(
        input.observedAt ?? new Date().toISOString(),
        input.roundId ?? null,
        input.multiplier,
        input.source ?? null,
        input.latencyMs ?? null,
        input.sessionId ?? null
      );
    }

    const query = `
      INSERT INTO multiplier_ticks (time, round_id, multiplier, source, latency_ms, session_id)
      VALUES ${placeholders.join(', ')}
    `;

    try {
      await this.pool.query(query, values);
      this.logger.debug(
        { component: 'TickRepository', count: batch.length },
        'Batch flushed (multi-row)'
      );
      return batch.length;
    } catch (error) {
      // Re-add to buffer for retry
      this.batchBuffer.unshift(...batch);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { component: 'TickRepository', error: message, batchSize: batch.length },
        'Batch flush failed'
      );
      throw new CriticalError(`Batch flush failed: ${message}`, 'TICK_BATCH_FLUSH_FAILED');
    }
  }

  /**
   * Find ticks for a specific round.
   */
  async findByRoundId(roundId: string): Promise<TickRecord[]> {
    const query = `
      SELECT time, round_id, multiplier, source, latency_ms, session_id
      FROM multiplier_ticks
      WHERE round_id = $1
      ORDER BY time ASC
    `;

    try {
      const result = await this.pool.query(query, [roundId]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('invalid input syntax for type uuid')) {
        return [];
      }
      this.logger.error({ component: 'TickRepository', error: message }, 'Failed to find ticks');
      throw new CriticalError(`Tick find failed: ${message}`, 'TICK_FIND_FAILED');
    }
  }

  /**
   * Find ticks within a time range.
   */
  async findByTimeRange(
    startTime: string,
    endTime: string,
    roundId?: string
  ): Promise<TickRecord[]> {
    let query: string;
    let params: unknown[];

    if (roundId) {
      query = `
        SELECT time, round_id, multiplier, source, latency_ms, session_id
        FROM multiplier_ticks
        WHERE time >= $1 AND time <= $2 AND round_id = $3
        ORDER BY time ASC
      `;
      params = [startTime, endTime, roundId];
    } else {
      query = `
        SELECT time, round_id, multiplier, source, latency_ms, session_id
        FROM multiplier_ticks
        WHERE time >= $1 AND time <= $2
        ORDER BY time ASC
      `;
      params = [startTime, endTime];
    }

    try {
      const result = await this.pool.query(query, params);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'TickRepository', error: message }, 'Failed to find ticks by time range');
      throw new CriticalError(`Tick find by time range failed: ${message}`, 'TICK_FIND_RANGE_FAILED');
    }
  }

  /**
   * Get tick count for a round.
   */
  async countByRoundId(roundId: string): Promise<number> {
    const query = `SELECT COUNT(*) as count FROM multiplier_ticks WHERE round_id = $1`;

    try {
      const result = await this.pool.query(query, [roundId]);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('invalid input syntax for type uuid')) {
        return 0;
      }
      this.logger.error({ component: 'TickRepository', error: message }, 'Failed to count ticks');
      throw new CriticalError(`Tick count failed: ${message}`, 'TICK_COUNT_FAILED');
    }
  }

  /**
   * Get average latency for a round.
   */
  async getAverageLatencyByRoundId(roundId: string): Promise<number> {
    const query = `
      SELECT AVG(latency_ms) as avg_latency
      FROM multiplier_ticks
      WHERE round_id = $1
    `;

    try {
      const result = await this.pool.query(query, [roundId]);
      const avg = result.rows[0].avg_latency;
      return avg !== null ? Number(avg) : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('invalid input syntax for type uuid')) {
        return 0;
      }
      this.logger.error({ component: 'TickRepository', error: message }, 'Failed to get average latency');
      throw new CriticalError(`Average latency query failed: ${message}`, 'TICK_AVG_LATENCY_FAILED');
    }
  }

  /**
   * Get the latest tick for a round.
   */
  async getLatestTick(roundId: string): Promise<TickRecord | null> {
    const query = `
      SELECT time, round_id, multiplier, source, latency_ms, session_id
      FROM multiplier_ticks
      WHERE round_id = $1
      ORDER BY time DESC
      LIMIT 1
    `;

    try {
      const result = await this.pool.query(query, [roundId]);
      if (result.rows.length === 0) return null;
      return this.mapRow(result.rows[0]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('invalid input syntax for type uuid')) {
        return null;
      }
      this.logger.error({ component: 'TickRepository', error: message }, 'Failed to get latest tick');
      throw new CriticalError(`Latest tick query failed: ${message}`, 'TICK_LATEST_FAILED');
    }
  }

  /**
   * Delete ticks for a round.
   */
  async deleteByRoundId(roundId: string): Promise<number> {
    const query = `DELETE FROM multiplier_ticks WHERE round_id = $1`;

    try {
      const result = await this.pool.query(query, [roundId]);
      return result.rowCount ?? 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('invalid input syntax for type uuid')) {
        return 0;
      }
      this.logger.error({ component: 'TickRepository', error: message }, 'Failed to delete ticks');
      throw new CriticalError(`Tick delete failed: ${message}`, 'TICK_DELETE_FAILED');
    }
  }

  private mapRow(row: Record<string, unknown>): TickRecord {
    return {
      time: String(row.time),
      roundId: row.round_id ? String(row.round_id) : null,
      multiplier: Number(row.multiplier),
      source: row.source ? String(row.source) : null,
      latencyMs: row.latency_ms !== null ? Number(row.latency_ms) : null,
      sessionId: row.session_id ? String(row.session_id) : null,
    };
  }
}

/**
 * InMemoryTickRepository provides an in-memory implementation for testing.
 */
export class InMemoryTickRepository {
  private ticks: TickRecord[] = [];

  async create(input: CreateTickInput): Promise<TickRecord> {
    const tick: TickRecord = {
      time: new Date().toISOString(),
      roundId: input.roundId ?? null,
      multiplier: input.multiplier,
      source: input.source ?? null,
      latencyMs: input.latencyMs ?? null,
      sessionId: input.sessionId ?? null,
    };
    this.ticks.push(tick);
    return tick;
  }

  async insert(input: CreateTickInput): Promise<void> {
    await this.create(input);
  }

  async stopBatching(): Promise<void> {
    // No-op for in-memory
  }

  async flushBatch(): Promise<number> {
    return 0;
  }

  async findByRoundId(roundId: string): Promise<TickRecord[]> {
    return this.ticks
      .filter((t) => t.roundId === roundId)
      .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  }

  async findByTimeRange(
    startTime: string,
    endTime: string,
    roundId?: string
  ): Promise<TickRecord[]> {
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    return this.ticks
      .filter((t) => {
        const time = new Date(t.time).getTime();
        return time >= start && time <= end && (roundId ? t.roundId === roundId : true);
      })
      .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  }

  async countByRoundId(roundId: string): Promise<number> {
    return this.ticks.filter((t) => t.roundId === roundId).length;
  }

  async getAverageLatencyByRoundId(roundId: string): Promise<number> {
    const ticks = this.ticks.filter((t) => t.roundId === roundId && t.latencyMs !== null);
    if (ticks.length === 0) return 0;
    return ticks.reduce((sum, t) => sum + (t.latencyMs ?? 0), 0) / ticks.length;
  }

  async getLatestTick(roundId: string): Promise<TickRecord | null> {
    const ticks = this.ticks
      .filter((t) => t.roundId === roundId)
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    return ticks[0] ?? null;
  }

  async deleteByRoundId(roundId: string): Promise<number> {
    const before = this.ticks.length;
    this.ticks = this.ticks.filter((t) => t.roundId !== roundId);
    return before - this.ticks.length;
  }
}
