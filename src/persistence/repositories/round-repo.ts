import { Pool } from 'pg';
import { getLogger } from '../../observability/logger';
import { CriticalError } from '../../utils/errors';
import { getPool } from '../client';

export interface RoundRecord {
  id: string;
  externalRoundId: string;
  sessionId: string;
  startedAt: string | null;
  crashedAt: string | null;
  observedCrashPoint: number | null;
  finalConfirmedCrashPoint: number | null;
  observationSource: string | null;
  dataQuality: string | null;
  createdAt: string;
}

export interface CreateRoundInput {
  externalRoundId: string;
  sessionId: string;
  startedAt?: string | null;
  crashedAt?: string | null;
  observedCrashPoint?: number | null;
  finalConfirmedCrashPoint?: number | null;
  observationSource?: string | null;
  dataQuality?: string | null;
}

export interface UpdateRoundInput {
  startedAt?: string | null;
  crashedAt?: string | null;
  observedCrashPoint?: number | null;
  finalConfirmedCrashPoint?: number | null;
  observationSource?: string | null;
  dataQuality?: string | null;
}

/**
 * RoundRepository provides CRUD operations for round records.
 * Stores crash points and observation metadata.
 */
export class RoundRepository {
  private readonly logger = getLogger();
  private pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool || getPool();
  }

  async create(input: CreateRoundInput): Promise<RoundRecord> {
    const query = `
      INSERT INTO rounds (
        external_round_id, session_id, started_at, crashed_at,
        observed_crash_point, final_confirmed_crash_point,
        observation_source, data_quality
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;

    try {
      const result = await this.pool.query(query, [
        input.externalRoundId,
        input.sessionId,
        input.startedAt ?? null,
        input.crashedAt ?? null,
        input.observedCrashPoint ?? null,
        input.finalConfirmedCrashPoint ?? null,
        input.observationSource ?? null,
        input.dataQuality ?? null,
      ]);

      const record = this.mapRow(result.rows[0]);
      this.logger.info(
        { component: 'RoundRepository', roundId: record.id, externalRoundId: record.externalRoundId },
        'Round created'
      );
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'RoundRepository', error: message }, 'Failed to create round');
      throw new CriticalError(`Round creation failed: ${message}`, 'ROUND_CREATE_FAILED');
    }
  }

  async findById(id: string): Promise<RoundRecord | null> {
    const query = `SELECT * FROM rounds WHERE id = $1`;

    try {
      const result = await this.pool.query(query, [id]);
      if (result.rows.length === 0) return null;
      return this.mapRow(result.rows[0]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('invalid input syntax for type uuid')) {
        return null;
      }
      this.logger.error({ component: 'RoundRepository', error: message }, 'Failed to find round');
      throw new CriticalError(`Round find failed: ${message}`, 'ROUND_FIND_FAILED');
    }
  }

  async findByExternalId(externalRoundId: string): Promise<RoundRecord | null> {
    const query = `SELECT * FROM rounds WHERE external_round_id = $1 ORDER BY created_at DESC LIMIT 1`;

    try {
      const result = await this.pool.query(query, [externalRoundId]);
      if (result.rows.length === 0) return null;
      return this.mapRow(result.rows[0]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'RoundRepository', error: message }, 'Failed to find round by external ID');
      throw new CriticalError(`Round find by external ID failed: ${message}`, 'ROUND_FIND_EXTERNAL_FAILED');
    }
  }

  async findBySessionId(sessionId: string, limit: number = 100): Promise<RoundRecord[]> {
    const query = `
      SELECT * FROM rounds
      WHERE session_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;

    try {
      const result = await this.pool.query(query, [sessionId, limit]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'RoundRepository', error: message }, 'Failed to find rounds by session');
      throw new CriticalError(`Round find by session failed: ${message}`, 'ROUND_FIND_SESSION_FAILED');
    }
  }

  async findAll(limit: number = 100, offset: number = 0): Promise<RoundRecord[]> {
    const query = `
      SELECT * FROM rounds
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `;

    try {
      const result = await this.pool.query(query, [limit, offset]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'RoundRepository', error: message }, 'Failed to list rounds');
      throw new CriticalError(`Round list failed: ${message}`, 'ROUND_LIST_FAILED');
    }
  }

  async update(id: string, input: UpdateRoundInput): Promise<RoundRecord | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.startedAt !== undefined) {
      fields.push(`started_at = $${paramIndex++}`);
      values.push(input.startedAt);
    }
    if (input.crashedAt !== undefined) {
      fields.push(`crashed_at = $${paramIndex++}`);
      values.push(input.crashedAt);
    }
    if (input.observedCrashPoint !== undefined) {
      fields.push(`observed_crash_point = $${paramIndex++}`);
      values.push(input.observedCrashPoint);
    }
    if (input.finalConfirmedCrashPoint !== undefined) {
      fields.push(`final_confirmed_crash_point = $${paramIndex++}`);
      values.push(input.finalConfirmedCrashPoint);
    }
    if (input.observationSource !== undefined) {
      fields.push(`observation_source = $${paramIndex++}`);
      values.push(input.observationSource);
    }
    if (input.dataQuality !== undefined) {
      fields.push(`data_quality = $${paramIndex++}`);
      values.push(input.dataQuality);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    values.push(id);

    const query = `
      UPDATE rounds
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    try {
      const result = await this.pool.query(query, values);
      if (result.rows.length === 0) return null;
      const record = this.mapRow(result.rows[0]);
      this.logger.debug({ component: 'RoundRepository', roundId: id }, 'Round updated');
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'RoundRepository', error: message }, 'Failed to update round');
      throw new CriticalError(`Round update failed: ${message}`, 'ROUND_UPDATE_FAILED');
    }
  }

  async delete(id: string): Promise<boolean> {
    const query = `DELETE FROM rounds WHERE id = $1`;

    try {
      const result = await this.pool.query(query, [id]);
      const deleted = result.rowCount !== null && result.rowCount > 0;
      if (deleted) {
        this.logger.info({ component: 'RoundRepository', roundId: id }, 'Round deleted');
      }
      return deleted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'RoundRepository', error: message }, 'Failed to delete round');
      throw new CriticalError(`Round delete failed: ${message}`, 'ROUND_DELETE_FAILED');
    }
  }

  async count(): Promise<number> {
    const query = `SELECT COUNT(*) as count FROM rounds`;

    try {
      const result = await this.pool.query(query);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'RoundRepository', error: message }, 'Failed to count rounds');
      throw new CriticalError(`Round count failed: ${message}`, 'ROUND_COUNT_FAILED');
    }
  }

  /**
   * Retrieve completed rounds ordered by crash time (or created_at) ascending
   * for a closed time window. Bounded; never loads unbounded history.
   */
  async findCompletedInRange(
    fromIso: string,
    toIso: string,
    limit = 5000
  ): Promise<RoundRecord[]> {
    const query = `
      SELECT * FROM rounds
      WHERE COALESCE(crashed_at, created_at) >= $1
        AND COALESCE(crashed_at, created_at) < $2
        AND (final_confirmed_crash_point IS NOT NULL OR observed_crash_point IS NOT NULL)
      ORDER BY COALESCE(crashed_at, created_at) ASC
      LIMIT $3
    `;
    try {
      const result = await this.pool.query(query, [fromIso, toIso, limit]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'RoundRepository', error: message }, 'Failed to find rounds in range');
      throw new CriticalError(`Round range query failed: ${message}`, 'ROUND_RANGE_FAILED');
    }
  }

  /**
   * Most recent completed rounds (newest first) for rolling windows.
   */
  async findRecentCompleted(limit = 500): Promise<RoundRecord[]> {
    const query = `
      SELECT * FROM rounds
      WHERE final_confirmed_crash_point IS NOT NULL OR observed_crash_point IS NOT NULL
      ORDER BY COALESCE(crashed_at, created_at) DESC
      LIMIT $1
    `;
    try {
      const result = await this.pool.query(query, [limit]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'RoundRepository', error: message }, 'Failed to find recent rounds');
      throw new CriticalError(`Round recent query failed: ${message}`, 'ROUND_RECENT_FAILED');
    }
  }

  private mapRow(row: Record<string, unknown>): RoundRecord {
    return {
      id: String(row.id),
      externalRoundId: String(row.external_round_id),
      sessionId: String(row.session_id),
      startedAt: row.started_at ? String(row.started_at) : null,
      crashedAt: row.crashed_at ? String(row.crashed_at) : null,
      observedCrashPoint: row.observed_crash_point !== null ? Number(row.observed_crash_point) : null,
      finalConfirmedCrashPoint: row.final_confirmed_crash_point !== null ? Number(row.final_confirmed_crash_point) : null,
      observationSource: row.observation_source ? String(row.observation_source) : null,
      dataQuality: row.data_quality ? String(row.data_quality) : null,
      createdAt: String(row.created_at),
    };
  }
}

/**
 * InMemoryRoundRepository provides an in-memory implementation for testing.
 */
export class InMemoryRoundRepository {
  private rounds: Map<string, RoundRecord> = new Map();
  private nextId = 1;

  async create(input: CreateRoundInput): Promise<RoundRecord> {
    const now = new Date().toISOString();
    const round: RoundRecord = {
      id: `round-${this.nextId++}`,
      externalRoundId: input.externalRoundId,
      sessionId: input.sessionId,
      startedAt: input.startedAt ?? now,
      crashedAt: input.crashedAt ?? null,
      observedCrashPoint: input.observedCrashPoint ?? null,
      finalConfirmedCrashPoint: input.finalConfirmedCrashPoint ?? null,
      observationSource: input.observationSource ?? null,
      dataQuality: input.dataQuality ?? null,
      createdAt: now,
    };
    this.rounds.set(round.id, round);
    return round;
  }

  async findById(id: string): Promise<RoundRecord | null> {
    // Check both internal id and externalRoundId for compatibility
    const byId = this.rounds.get(id);
    if (byId) return byId;
    return Array.from(this.rounds.values()).find((r) => r.externalRoundId === id) ?? null;
  }

  async findByExternalId(externalRoundId: string): Promise<RoundRecord | null> {
    return Array.from(this.rounds.values()).find((r) => r.externalRoundId === externalRoundId) ?? null;
  }

  async findBySessionId(sessionId: string, limit = 100): Promise<RoundRecord[]> {
    return Array.from(this.rounds.values())
      .filter((r) => r.sessionId === sessionId)
      .slice(0, limit);
  }

  async findAll(limit = 100, offset = 0): Promise<RoundRecord[]> {
    return Array.from(this.rounds.values()).slice(offset, offset + limit);
  }

  async update(id: string, input: UpdateRoundInput): Promise<RoundRecord | null> {
    const round = this.rounds.get(id);
    if (!round) return null;
    const updated: RoundRecord = {
      ...round,
      startedAt: input.startedAt !== undefined ? input.startedAt : round.startedAt,
      crashedAt: input.crashedAt !== undefined ? input.crashedAt : round.crashedAt,
      observedCrashPoint: input.observedCrashPoint !== undefined ? input.observedCrashPoint : round.observedCrashPoint,
      finalConfirmedCrashPoint: input.finalConfirmedCrashPoint !== undefined ? input.finalConfirmedCrashPoint : round.finalConfirmedCrashPoint,
      observationSource: input.observationSource !== undefined ? input.observationSource : round.observationSource,
      dataQuality: input.dataQuality !== undefined ? input.dataQuality : round.dataQuality,
    };
    this.rounds.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.rounds.delete(id);
  }

  async count(): Promise<number> {
    return this.rounds.size;
  }

  async findCompletedInRange(fromIso: string, toIso: string, limit = 5000): Promise<RoundRecord[]> {
    const from = new Date(fromIso).getTime();
    const to = new Date(toIso).getTime();
    return Array.from(this.rounds.values())
      .filter((r) => {
        const t = new Date(r.crashedAt ?? r.createdAt).getTime();
        const hasPoint = r.finalConfirmedCrashPoint != null || r.observedCrashPoint != null;
        return hasPoint && t >= from && t < to;
      })
      .sort((a, b) => new Date(a.crashedAt ?? a.createdAt).getTime() - new Date(b.crashedAt ?? b.createdAt).getTime())
      .slice(0, limit);
  }

  async findRecentCompleted(limit = 500): Promise<RoundRecord[]> {
    return Array.from(this.rounds.values())
      .filter((r) => r.finalConfirmedCrashPoint != null || r.observedCrashPoint != null)
      .sort((a, b) => new Date(b.crashedAt ?? b.createdAt).getTime() - new Date(a.crashedAt ?? a.createdAt).getTime())
      .slice(0, limit);
  }
}
