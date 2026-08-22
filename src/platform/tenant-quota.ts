/**
 * Optional multi-tenant quota gate for the engine process.
 * Single-tenant (no TENANT_ID) always allows — existing behavior unchanged.
 */

import { getLogger } from '../observability/logger.js';
import { TenantManager } from './tenant-manager.js';

const logger = getLogger();

export async function checkTenantQuota(): Promise<{ allowed: boolean; reason?: string }> {
  const tenantId = process.env.TENANT_ID;
  if (!tenantId) {
    return { allowed: true };
  }
  try {
    const tenants = new TenantManager();
    return await tenants.canPlaceBet(tenantId);
  } catch (err) {
    logger.error(
      { component: 'TenantQuota', error: String(err) },
      'Quota check failed — deny in tenant mode'
    );
    return { allowed: false, reason: 'quota_check_failed' };
  }
}

export async function recordTenantEntry(): Promise<void> {
  const tenantId = process.env.TENANT_ID;
  if (!tenantId) return;
  try {
    const tenants = new TenantManager();
    await tenants.incrementDailyEntries(tenantId);
  } catch (err) {
    logger.error(
      { component: 'TenantQuota', error: String(err) },
      'Failed to increment tenant daily entries'
    );
  }
}
