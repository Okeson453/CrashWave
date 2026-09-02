/**
 * Mandatory tenant query scope — fail-closed when tenant missing in production.
 */
import type { PoolClient } from 'pg';
import { getPool } from './client.js';

export async function withTenantContext<T>(
  tenantId: string | null | undefined,
  fn: (client: PoolClient) => Promise<T>,
  opts?: { platform?: boolean }
): Promise<T> {
  if (!opts?.platform && (!tenantId || tenantId.length < 8)) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('TENANT_CONTEXT_REQUIRED');
    }
  }
  const client = await getPool().connect();
  try {
    if (opts?.platform) {
      await client.query(`SELECT set_config('app.platform_role', 'control_plane', true)`);
    }
    if (tenantId) {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    }
    return await fn(client);
  } finally {
    client.release();
  }
}
