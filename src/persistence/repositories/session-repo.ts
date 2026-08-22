import { Pool } from 'pg';
import { getLogger } from '../../observability/logger';
import { CriticalError } from '../../utils/errors';
import { getPool } from '../client';

export interface SessionRecord {
  id: string;
  mode: string;
  status: string;
  configVersion: number;
  notes: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionInput {
  mode: string;
  status: string;
  configVersion: number;
  notes?: string | null;
}

export interface UpdateSessionInput {
  mode?: string;
  status?: string;
  configVersion?: number;
  notes?: string | null;
  endedAt?: string | null;
}

/**
 * SessionRepository provides CRUD operations for automation sessions.
 * Tracks mode, status, config versions, and session metadata.
 */
export class SessionRepository {
  private readonly logger = getLogger();
  private pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool || getPool();
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const query = `
      INSERT INTO sessions (mode, status, config_version, notes)
      VALUES ($1, $2, $3, $4)
      RETURNING id, mode, status, config_version, notes, started_at, ended_at, created_at, updated_at
    `;

    try {
      const result = await this.pool.query(query, [
        input.mode,
        input.status,
        input.configVersion,
        input.notes ?? null,
      ]);

      const row = result.rows[0];
      const record = this.mapRow(row);
      this.logger.info({ component: 'SessionRepository', sessionId: record.id }, 'Session created');
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'SessionRepository', error: message }, 'Failed to create session');
      throw new CriticalError(`Session creation failed: ${message}`, 'SESSION_CREATE_FAILED');
    }
  }

  async findById(id: string): Promise<SessionRecord | null> {
    const query = `
      SELECT id, mode, status, config_version, notes, started_at, ended_at, created_at, updated_at
      FROM sessions
      WHERE id = $1
    `;

    try {
      const result = await this.pool.query(query, [id]);
      if (result.rows.length === 0) return null;
      return this.mapRow(result.rows[0]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('invalid input syntax for type uuid')) {
        return null;
      }
      this.logger.error({ component: 'SessionRepository', error: message }, 'Failed to find session');
      throw new CriticalError(`Session find failed: ${message}`, 'SESSION_FIND_FAILED');
    }
  }

  async findAll(limit: number = 100, offset: number = 0): Promise<SessionRecord[]> {
    const query = `
      SELECT id, mode, status, config_version, notes, started_at, ended_at, created_at, updated_at
      FROM sessions
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `;

    try {
      const result = await this.pool.query(query, [limit, offset]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'SessionRepository', error: message }, 'Failed to list sessions');
      throw new CriticalError(`Session list failed: ${message}`, 'SESSION_LIST_FAILED');
    }
  }

  async findByStatus(status: string, limit: number = 100): Promise<SessionRecord[]> {
    const query = `
      SELECT id, mode, status, config_version, notes, started_at, ended_at, created_at, updated_at
      FROM sessions
      WHERE status = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;

    try {
      const result = await this.pool.query(query, [status, limit]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'SessionRepository', error: message }, 'Failed to find sessions by status');
      throw new CriticalError(`Session find by status failed: ${message}`, 'SESSION_FIND_STATUS_FAILED');
    }
  }

  async update(id: string, input: UpdateSessionInput): Promise<SessionRecord | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.mode !== undefined) {
      fields.push(`mode = $${paramIndex++}`);
      values.push(input.mode);
    }
    if (input.status !== undefined) {
      fields.push(`status = $${paramIndex++}`);
      values.push(input.status);
    }
    if (input.configVersion !== undefined) {
      fields.push(`config_version = $${paramIndex++}`);
      values.push(input.configVersion);
    }
    if (input.notes !== undefined) {
      fields.push(`notes = $${paramIndex++}`);
      values.push(input.notes);
    }
    if (input.endedAt !== undefined) {
      fields.push(`ended_at = $${paramIndex++}`);
      values.push(input.endedAt);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const query = `
      UPDATE sessions
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, mode, status, config_version, notes, started_at, ended_at, created_at, updated_at
    `;

    try {
      const result = await this.pool.query(query, values);
      if (result.rows.length === 0) return null;
      const record = this.mapRow(result.rows[0]);
      this.logger.debug({ component: 'SessionRepository', sessionId: id }, 'Session updated');
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('invalid input syntax for type uuid')) {
        return null;
      }
      this.logger.error({ component: 'SessionRepository', error: message }, 'Failed to update session');
      throw new CriticalError(`Session update failed: ${message}`, 'SESSION_UPDATE_FAILED');
    }
  }

  async delete(id: string): Promise<boolean> {
    const query = `DELETE FROM sessions WHERE id = $1`;

    try {
      const result = await this.pool.query(query, [id]);
      const deleted = result.rowCount !== null && result.rowCount > 0;
      if (deleted) {
        this.logger.info({ component: 'SessionRepository', sessionId: id }, 'Session deleted');
      }
      return deleted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('invalid input syntax for type uuid')) {
        return false;
      }
      this.logger.error({ component: 'SessionRepository', error: message }, 'Failed to delete session');
      throw new CriticalError(`Session delete failed: ${message}`, 'SESSION_DELETE_FAILED');
    }
  }

  async count(): Promise<number> {
    const query = `SELECT COUNT(*) as count FROM sessions`;

    try {
      const result = await this.pool.query(query);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'SessionRepository', error: message }, 'Failed to count sessions');
      throw new CriticalError(`Session count failed: ${message}`, 'SESSION_COUNT_FAILED');
    }
  }

  private mapRow(row: Record<string, unknown>): SessionRecord {
    return {
      id: String(row.id),
      mode: String(row.mode),
      status: String(row.status),
      configVersion: Number(row.config_version),
      notes: row.notes ? String(row.notes) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
      endedAt: row.ended_at ? String(row.ended_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

/**
 * InMemorySessionRepository provides an in-memory implementation for testing.
 */
export class InMemorySessionRepository {
  private sessions: Map<string, SessionRecord> = new Map();
  private nextId = 1;

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: `sess-${this.nextId++}`,
      mode: input.mode,
      status: input.status,
      configVersion: input.configVersion,
      notes: input.notes ?? null,
      startedAt: now,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async findById(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async findAll(limit = 100, offset = 0): Promise<SessionRecord[]> {
    return Array.from(this.sessions.values()).slice(offset, offset + limit);
  }

  async findByStatus(status: string, limit = 100): Promise<SessionRecord[]> {
    return Array.from(this.sessions.values())
      .filter((s) => s.status === status)
      .slice(0, limit);
  }

  async update(id: string, input: UpdateSessionInput): Promise<SessionRecord | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    const updated: SessionRecord = {
      ...session,
      mode: input.mode ?? session.mode,
      status: input.status ?? session.status,
      configVersion: input.configVersion ?? session.configVersion,
      notes: input.notes !== undefined ? input.notes : session.notes,
      endedAt: input.endedAt !== undefined ? input.endedAt : session.endedAt,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async count(): Promise<number> {
    return this.sessions.size;
  }
}
