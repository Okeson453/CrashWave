/**
 * Tenant engine heartbeat — call from tenant process while TENANT_ID is set.
 */

import { getPool } from '../persistence/client.js';
import { getLogger } from '../observability/logger.js';

const logger = getLogger();

export async function reportTenantHeartbeat(extra?: {
  dailyEntriesUsed?: number;
  pnlToday?: number;
  mode?: string;
}): Promise<void> {
  const tenantId = process.env.TENANT_ID;
  if (!tenantId) return;

  try {
    const sets = ['last_heartbeat = NOW()', 'updated_at = NOW()'];
    const values: unknown[] = [];
    let i = 1;
    if (extra?.dailyEntriesUsed != null) {
      sets.push(`daily_entries_used = $${i++}`);
      values.push(extra.dailyEntriesUsed);
    }
    if (extra?.pnlToday != null) {
      sets.push(`pnl_today = $${i++}`);
      values.push(extra.pnlToday);
    }
    if (extra?.mode) {
      sets.push(`mode = $${i++}`);
      values.push(extra.mode);
    }
    values.push(tenantId);
    await getPool().query(
      `UPDATE tenant_instances SET ${sets.join(', ')} WHERE user_id = $${i}`,
      values
    );
  } catch (err) {
    logger.warn(
      { component: 'TenantHeartbeat', error: String(err) },
      'Heartbeat update failed'
    );
  }
}

export function startHeartbeatLoop(intervalMs = 60_000): () => void {
  if (!process.env.TENANT_ID) return () => undefined;
  const timer = setInterval(() => {
    void reportTenantHeartbeat();
  }, intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) (timer as NodeJS.Timeout).unref();
  void reportTenantHeartbeat();
  return () => clearInterval(timer);
}
