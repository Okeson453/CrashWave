import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getLogger } from '../observability/logger';
import { withRetry } from '../utils/retry';

export interface DatabaseConfig {
  connectionString: string;
  poolSize?: number;
}

let pool: Pool | null = null;

export function createPool(config: DatabaseConfig): Pool {
  if (pool) {
    return pool;
  }

  pool = new Pool({
    connectionString: config.connectionString,
    max: config.poolSize ?? 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    getLogger().error({ component: 'Database' }, `Unexpected database pool error: ${err.message}`);
  });

  pool.on('connect', (client) => {
    const tenantId = process.env.TENANT_ID;
    const controlPlane = (process.env.PLATFORM_MODE ?? '').toLowerCase() === 'control-plane';
    // pg-pool emits `connect` before handing the client to the pool consumer.
    // Queue the security GUC first so every subsequent query on this process
    // uses the correct tenant boundary. withTenantContext() additionally uses
    // SET LOCAL for transaction-scoped defense in depth.
    void (async () => {
      try {
        if (tenantId) {
          await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
          await client.query(`SELECT set_config('app.platform_role', '', false)`);
        } else if (controlPlane) {
          await client.query(`SELECT set_config('app.tenant_id', '', false)`);
          await client.query(`SELECT set_config('app.platform_role', 'control_plane', false)`);
        }
      } catch (err) {
        getLogger().error({ component: 'Database', error: String(err) }, 'Failed to initialize connection security context');
        client.end().catch(() => undefined);
      }
    })();
    getLogger().debug({ component: 'Database' }, 'New database connection established');
  });

  return pool;
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database pool not initialized. Call createPool() first.');
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return withRetry(
    async () => {
      const result = await getPool().query<T>(sql, params);
      return result;
    },
    {
      maxRetries: 3,
      baseDelayMs: 500,
      maxDelayMs: 5000,
      retryableErrors: ['Connection terminated unexpectedly'],
    }
  );
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    getLogger().info({ component: 'Database' }, 'Database pool closed');
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    const result = await query<{ health: number }>('SELECT 1 as health');
    return result.rows[0]?.health === 1;
  } catch {
    return false;
  }
}
