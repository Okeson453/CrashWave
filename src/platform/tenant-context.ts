/**
 * Tenant context helpers.
 *
 * IMPORTANT: PostgreSQL GUCs are connection-local. Setting app.tenant_id on
 * pool.query() is unsafe because the next query may use another pooled
 * connection. Tenant-scoped work must therefore run inside withTenantContext()
 * so SET LOCAL and the protected query share one connection/transaction.
 */
import { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '../persistence/client';
import { getLogger } from '../observability/logger';

const logger = getLogger();

export interface TenantDbContext {
  tenantId: string;
  client: PoolClient;
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<import('pg').QueryResult<T>>;
}

export async function withTenantContext<T>(
  tenantId: string,
  fn: (ctx: TenantDbContext) => Promise<T>
): Promise<T> {
  if (!tenantId) throw new Error('tenantId is required');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('app.platform_role', '', true)`);
    const ctx: TenantDbContext = {
      tenantId,
      client,
      query: (sql, params) => client.query(sql, params),
    };
    const result = await fn(ctx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Kept for compatibility. It no longer mutates a random pooled connection.
 * Startup should validate that a tenant is present; tenant work should use
 * withTenantContext().
 */
export async function applyTenantDbContext(tenantId?: string): Promise<void> {
  const id = tenantId ?? process.env.TENANT_ID;
  const controlPlane = (process.env.PLATFORM_MODE ?? '').toLowerCase() === 'control-plane';
  if (!id && !controlPlane) {
    throw new Error('TENANT_ID is required for engine mode; refusing unsafe global DB context');
  }
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('TENANT_ID must be a valid tenant UUID from users.id');
  }
  logger.info({ component: 'TenantContext', tenantId: id ?? null, controlPlane }, 'Tenant context validated');
}

export function getTenantId(): string | null {
  return process.env.TENANT_ID ?? null;
}
