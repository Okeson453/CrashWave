import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getLogger } from '../observability/logger';
import { withRetry } from '../utils/retry';

export interface DatabaseConfig {
  connectionString: string;
  poolSize?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  queryTimeoutMillis?: number;
}

let pool: Pool | null = null;

/**
 * Normalize DATABASE_URL SSL params so pg-connection-string does not emit the
 * "prefer/require/verify-ca treated as verify-full" deprecation warning.
 * Explicit `ssl` Pool option is the source of truth.
 */
export function normalizeConnectionString(raw: string): {
  connectionString: string;
  urlSslMode: string | null;
} {
  try {
    const u = new URL(raw);
    const urlSslMode = (u.searchParams.get('sslmode') ?? '').toLowerCase() || null;
    u.searchParams.delete('sslmode');
    u.searchParams.delete('uselibpqcompat');
    return { connectionString: u.toString(), urlSslMode };
  } catch {
    return { connectionString: raw, urlSslMode: null };
  }
}

function resolveSsl(
  urlSslMode: string | null
): boolean | { rejectUnauthorized: boolean } | undefined {
  const sslMode = (
    process.env.DATABASE_SSL_MODE ??
    process.env.PGSSLMODE ??
    urlSslMode ??
    ''
  ).toLowerCase();

  if (sslMode === 'disable' || sslMode === 'false') {
    return false;
  }
  // Railway / managed Postgres: TLS on, private CA — do not require public CA verify.
  if (sslMode === 'require' || sslMode === 'prefer' || sslMode === 'no-verify') {
    return { rejectUnauthorized: false };
  }
  if (sslMode === 'verify-full' || sslMode === 'verify-ca') {
    return { rejectUnauthorized: true };
  }
  if (process.env.NODE_ENV === 'production') {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function buildPoolOptions(config: DatabaseConfig): ConstructorParameters<typeof Pool>[0] {
  const { connectionString, urlSslMode } = normalizeConnectionString(config.connectionString);
  const ssl = resolveSsl(urlSslMode);

  // Do NOT pass `options: -c statement_timeout=...`.
  // Railway Postgres / PgBouncer reject it:
  //   FATAL: unsupported startup parameter in options: statement_timeout
  // Per-query timeouts can be applied by callers when needed.
  return {
    connectionString,
    max: config.poolSize ?? Number(process.env.DATABASE_POOL_SIZE ?? process.env.DB_POOL_SIZE ?? 10),
    idleTimeoutMillis: config.idleTimeoutMillis ?? Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis:
      config.connectionTimeoutMillis ?? Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 5_000),
    ...(ssl !== undefined ? { ssl } : {}),
  };
}

export function createPool(config: DatabaseConfig): Pool {
  if (pool) {
    return pool;
  }

  const opts = buildPoolOptions(config);
  pool = new Pool(opts);

  pool.on('error', (err) => {
    getLogger().error({ component: 'Database' }, `Unexpected database pool error: ${err.message}`);
  });

  pool.on('connect', () => {
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

/** Snapshot for Prometheus / backpressure */
export function getPoolStats(): {
  total: number;
  idle: number;
  waiting: number;
} {
  const p = getPool() as Pool & {
    totalCount?: number;
    idleCount?: number;
    waitingCount?: number;
  };
  return {
    total: p.totalCount ?? 0,
    idle: p.idleCount ?? 0,
    waiting: p.waitingCount ?? 0,
  };
}

export function isPoolSaturated(threshold = 5): boolean {
  try {
    return getPoolStats().waiting >= threshold;
  } catch {
    return false;
  }
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

/** Close and clear singleton — allows re-init with different config (tests / multi-tenant workers) */
export async function resetPool(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = null;
  }
}

/** Create a non-singleton pool for isolated tenants / workers */
export function createIsolatedPool(config: DatabaseConfig): Pool {
  return new Pool(buildPoolOptions(config));
}
