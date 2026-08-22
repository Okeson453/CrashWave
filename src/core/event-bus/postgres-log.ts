/**
 * Postgres-backed durable event log (Phase 3).
 * Append-only; survives process restart.
 */

import { Pool } from 'pg';
import { PersistentLogEntry, PersistentLogWriter } from './persistent-log';
import { getLogger } from '../../observability/logger';

const ENSURE_TABLE = `
CREATE TABLE IF NOT EXISTS event_log (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  correlation_id TEXT NOT NULL,
  source TEXT NOT NULL,
  persisted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log (event_type);
CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_corr ON event_log (correlation_id);
`;

export class PostgresPersistentLog implements PersistentLogWriter {
  private ready = false;
  private readonly logger = getLogger();

  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    if (this.ready) return;
    await this.pool.query(ENSURE_TABLE);
    this.ready = true;
    this.logger.info({ component: 'PostgresPersistentLog' }, 'event_log table ready');
  }

  async write(entry: PersistentLogEntry): Promise<void> {
    if (!this.ready) {
      await this.ensureSchema();
    }
    try {
      await this.pool.query(
        `INSERT INTO event_log (id, event_type, payload, timestamp, correlation_id, source, persisted_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          entry.id,
          entry.eventType,
          JSON.stringify(entry.payload ?? {}),
          entry.timestamp,
          entry.correlationId,
          entry.source,
          entry.persistedAt,
        ]
      );
    } catch (err) {
      this.logger.warn(
        { component: 'PostgresPersistentLog', error: String(err), eventType: entry.eventType },
        'Failed to persist event (non-fatal)'
      );
    }
  }

  async getRecent(limit = 100): Promise<PersistentLogEntry[]> {
    if (!this.ready) await this.ensureSchema();
    const res = await this.pool.query(
      `SELECT id, event_type, payload, timestamp, correlation_id, source, persisted_at
       FROM event_log ORDER BY timestamp DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      payload: r.payload,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp),
      correlationId: r.correlation_id,
      source: r.source,
      persistedAt: r.persisted_at instanceof Date ? r.persisted_at.toISOString() : String(r.persisted_at),
    }));
  }
}
