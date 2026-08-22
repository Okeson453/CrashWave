import { Pool } from 'pg';
import { getLogger } from '../../observability/logger';
import { CriticalError } from '../../utils/errors';
import { getPool } from '../client';

/**
 * AuditLogRecord represents an immutable audit log entry.
 */
export interface AuditLogRecord {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  payload: Record<string, unknown> | null;
  severity: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
}

/**
 * Input for creating an audit log entry.
 */
export interface CreateAuditLogInput {
  actor: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  payload?: Record<string, unknown> | null;
  severity?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
}

/**
 * AuditRepository provides append-only operations for the audit log.
 *
 * The audit log is immutable — entries cannot be updated or deleted.
 * This is enforced by a database trigger (see migration 004).
 */
export class AuditRepository {
  private readonly logger = getLogger();
  private pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool || getPool();
  }

  /**
   * Append a new audit log entry.
   */
  async append(input: CreateAuditLogInput): Promise<AuditLogRecord> {
    const query = `
      INSERT INTO audit_logs (actor, action, entity_type, entity_id, payload, severity)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    try {
      const result = await this.pool.query(query, [
        input.actor,
        input.action,
        input.entityType,
        input.entityId ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
        input.severity ?? 'info',
      ]);

      const record = this.mapRow(result.rows[0]);
      this.logger.info(
        {
          component: 'AuditRepository',
          auditId: record.id,
          actor: record.actor,
          action: record.action,
        },
        'Audit log entry created'
      );
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'AuditRepository', error: message }, 'Failed to create audit log');
      throw new CriticalError(`Audit log creation failed: ${message}`, 'AUDIT_CREATE_FAILED');
    }
  }

  /**
   * Find an audit log entry by ID.
   */
  async findById(id: string): Promise<AuditLogRecord | null> {
    const query = `SELECT * FROM audit_logs WHERE id = $1`;

    try {
      const result = await this.pool.query(query, [id]);
      if (result.rows.length === 0) return null;
      return this.mapRow(result.rows[0]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'AuditRepository', error: message }, 'Failed to find audit log');
      throw new CriticalError(`Audit log find failed: ${message}`, 'AUDIT_FIND_FAILED');
    }
  }

  /**
   * Find audit log entries by actor.
   */
  async findByActor(actor: string, limit: number = 100): Promise<AuditLogRecord[]> {
    const query = `
      SELECT * FROM audit_logs
      WHERE actor = $1
      ORDER BY timestamp DESC
      LIMIT $2
    `;

    try {
      const result = await this.pool.query(query, [actor, limit]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'AuditRepository', error: message }, 'Failed to find audit logs by actor');
      throw new CriticalError(`Audit log find by actor failed: ${message}`, 'AUDIT_FIND_ACTOR_FAILED');
    }
  }

  /**
   * Find audit log entries by action.
   */
  async findByAction(action: string, limit: number = 100): Promise<AuditLogRecord[]> {
    const query = `
      SELECT * FROM audit_logs
      WHERE action = $1
      ORDER BY timestamp DESC
      LIMIT $2
    `;

    try {
      const result = await this.pool.query(query, [action, limit]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'AuditRepository', error: message }, 'Failed to find audit logs by action');
      throw new CriticalError(`Audit log find by action failed: ${message}`, 'AUDIT_FIND_ACTION_FAILED');
    }
  }

  /**
   * Find audit log entries by entity.
   */
  async findByEntity(
    entityType: string,
    entityId: string,
    limit: number = 100
  ): Promise<AuditLogRecord[]> {
    const query = `
      SELECT * FROM audit_logs
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY timestamp DESC
      LIMIT $3
    `;

    try {
      const result = await this.pool.query(query, [entityType, entityId, limit]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'AuditRepository', error: message }, 'Failed to find audit logs by entity');
      throw new CriticalError(`Audit log find by entity failed: ${message}`, 'AUDIT_FIND_ENTITY_FAILED');
    }
  }

  /**
   * Find audit log entries with severity >= the given level.
   */
  async findBySeverity(
    severity: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    limit: number = 100
  ): Promise<AuditLogRecord[]> {
    const severityOrder = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    const minIndex = severityOrder.indexOf(severity);
    const validSeverities = severityOrder.slice(minIndex);

    const query = `
      SELECT * FROM audit_logs
      WHERE severity = ANY($1)
      ORDER BY timestamp DESC
      LIMIT $2
    `;

    try {
      const result = await this.pool.query(query, [validSeverities, limit]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'AuditRepository', error: message }, 'Failed to find audit logs by severity');
      throw new CriticalError(`Audit log find by severity failed: ${message}`, 'AUDIT_FIND_SEVERITY_FAILED');
    }
  }

  /**
   * Find all audit log entries within a time range.
   */
  async findInRange(
    start: Date,
    end: Date,
    limit: number = 1000
  ): Promise<AuditLogRecord[]> {
    const query = `
      SELECT * FROM audit_logs
      WHERE timestamp >= $1 AND timestamp <= $2
      ORDER BY timestamp DESC
      LIMIT $3
    `;

    try {
      const result = await this.pool.query(query, [start.toISOString(), end.toISOString(), limit]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'AuditRepository', error: message }, 'Failed to find audit logs in range');
      throw new CriticalError(`Audit log find in range failed: ${message}`, 'AUDIT_FIND_RANGE_FAILED');
    }
  }

  /**
   * Find recent audit log entries.
   */
  async findRecent(hours: number = 24, limit: number = 1000): Promise<AuditLogRecord[]> {
    const start = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.findInRange(start, new Date(), limit);
  }

  /**
   * Count total audit log entries.
   */
  async count(): Promise<number> {
    const query = `SELECT COUNT(*) as count FROM audit_logs`;

    try {
      const result = await this.pool.query(query);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'AuditRepository', error: message }, 'Failed to count audit logs');
      throw new CriticalError(`Audit log count failed: ${message}`, 'AUDIT_COUNT_FAILED');
    }
  }

  private mapRow(row: Record<string, unknown>): AuditLogRecord {
    return {
      id: String(row.id),
      timestamp: String(row.timestamp),
      actor: String(row.actor),
      action: String(row.action),
      entityType: String(row.entity_type),
      entityId: row.entity_id ? String(row.entity_id) : null,
      payload: row.payload ? (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) : null,
      severity: String(row.severity) as AuditLogRecord['severity'],
    };
  }
}
