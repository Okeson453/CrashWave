/**
 * TenantManager — CRUD for users, plans, subscriptions, instances + quota.
 */

import { getPool } from '../persistence/client.js';
import { getLogger } from '../observability/logger.js';
import { Tenant, TenantInstance, Plan, QuotaResult, TenantStatus } from './types.js';

export class TenantManager {
  private readonly logger = getLogger();

  async createUser(params: {
    telegramId: bigint | number;
    telegramUsername?: string;
    email?: string;
    planId?: string;
  }): Promise<Tenant> {
    const result = await getPool().query(
      `INSERT INTO users (telegram_id, telegram_username, email, plan_id, status)
       VALUES ($1, $2, $3, $4, 'onboarding')
       RETURNING *`,
      [
        params.telegramId.toString(),
        params.telegramUsername ?? null,
        params.email ?? null,
        params.planId ?? null,
      ]
    );
    const row = result.rows[0];
    this.logger.info({ component: 'TenantManager', userId: row.id }, 'User created');
    return this.rowToTenant(row);
  }

  async getUserByTelegramId(telegramId: bigint | number): Promise<Tenant | null> {
    const result = await getPool().query('SELECT * FROM users WHERE telegram_id = $1', [
      telegramId.toString(),
    ]);
    if (result.rows.length === 0) return null;
    return this.rowToTenant(result.rows[0]);
  }

  async getUserById(id: string): Promise<Tenant | null> {
    const result = await getPool().query('SELECT * FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;
    return this.rowToTenant(result.rows[0]);
  }

  async updateUserStatus(id: string, status: TenantStatus): Promise<void> {
    await getPool().query('UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2', [
      status,
      id,
    ]);
    this.logger.info({ component: 'TenantManager', userId: id, status }, 'User status updated');
  }

  async assignPlan(userId: string, planId: string): Promise<void> {
    await getPool().query('UPDATE users SET plan_id = $1, updated_at = NOW() WHERE id = $2', [
      planId,
      userId,
    ]);
  }

  async getPlan(id: string): Promise<Plan | null> {
    const result = await getPool().query('SELECT * FROM plans WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;
    return this.rowToPlan(result.rows[0]);
  }

  async getPlanByName(name: string): Promise<Plan | null> {
    const result = await getPool().query('SELECT * FROM plans WHERE name = $1', [name]);
    if (result.rows.length === 0) return null;
    return this.rowToPlan(result.rows[0]);
  }

  async listActivePlans(): Promise<Plan[]> {
    const result = await getPool().query(
      'SELECT * FROM plans WHERE is_active = true ORDER BY price_monthly'
    );
    return result.rows.map((r) => this.rowToPlan(r));
  }

  async getInstance(userId: string): Promise<TenantInstance | null> {
    const result = await getPool().query(
      'SELECT * FROM tenant_instances WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId]
    );
    if (result.rows.length === 0) return null;
    return this.rowToInstance(result.rows[0]);
  }

  async createInstance(userId: string): Promise<TenantInstance> {
    const result = await getPool().query(
      `INSERT INTO tenant_instances (user_id, status, mode)
       VALUES ($1, 'provisioning', 'observe-only')
       RETURNING *`,
      [userId]
    );
    return this.rowToInstance(result.rows[0]);
  }

  async updateInstance(
    userId: string,
    updates: Partial<{
      containerId: string | null;
      containerHost: string | null;
      status: string;
      mode: string;
      dailyEntriesUsed: number;
      dailyResetAt: Date | null;
      pnlToday: number;
      pnlTotal: number;
      lastHeartbeat: Date | null;
    }>
  ): Promise<void> {
    const map: Record<string, string> = {
      containerId: 'container_id',
      containerHost: 'container_host',
      status: 'status',
      mode: 'mode',
      dailyEntriesUsed: 'daily_entries_used',
      dailyResetAt: 'daily_reset_at',
      pnlToday: 'pnl_today',
      pnlTotal: 'pnl_total',
      lastHeartbeat: 'last_heartbeat',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    for (const [key, val] of Object.entries(updates)) {
      if (val === undefined) continue;
      const col = map[key];
      if (!col) continue;
      sets.push(`${col} = $${idx++}`);
      values.push(val);
    }
    if (sets.length === 0) return;
    values.push(userId);
    await getPool().query(
      `UPDATE tenant_instances SET ${sets.join(', ')}, updated_at = NOW()
       WHERE user_id = $${idx}`,
      values
    );
  }

  async canPlaceBet(userId: string): Promise<QuotaResult> {
    const user = await this.getUserById(userId);
    if (!user) return { allowed: false, reason: 'User not found' };
    if (user.status !== 'active') return { allowed: false, reason: `Account ${user.status}` };

    const instance = await this.getInstance(userId);
    if (!instance || instance.status !== 'running') {
      return { allowed: false, reason: 'Engine not running' };
    }

    const plan = user.planId ? await this.getPlan(user.planId) : null;
    if (!plan) return { allowed: false, reason: 'No active plan' };
    if (plan.maxDailyEntries <= 0) {
      return { allowed: false, reason: 'Plan does not allow live entries' };
    }

    const now = new Date();
    if (!instance.dailyResetAt || this.isNewDay(instance.dailyResetAt, now, user.timezone)) {
      await getPool().query(
        `UPDATE tenant_instances
         SET daily_entries_used = 0, daily_reset_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
      return { allowed: true };
    }

    if (instance.dailyEntriesUsed >= plan.maxDailyEntries) {
      return {
        allowed: false,
        reason: `Daily limit reached (${plan.maxDailyEntries})`,
      };
    }
    return { allowed: true };
  }

  async incrementDailyEntries(userId: string): Promise<void> {
    await getPool().query(
      `UPDATE tenant_instances
       SET daily_entries_used = daily_entries_used + 1, updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );
  }

  async audit(params: {
    actorType: 'system' | 'admin' | 'user' | 'billing';
    actorId?: string;
    action: string;
    targetUserId?: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    await getPool().query(
      `INSERT INTO platform_audit_logs (actor_type, actor_id, action, target_user_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        params.actorType,
        params.actorId ?? null,
        params.action,
        params.targetUserId ?? null,
        params.payload ? JSON.stringify(params.payload) : null,
      ]
    );
  }

  private rowToTenant(row: Record<string, unknown>): Tenant {
    return {
      id: String(row.id),
      telegramId: BigInt(String(row.telegram_id)),
      telegramUsername: (row.telegram_username as string) ?? null,
      email: (row.email as string) ?? null,
      status: row.status as Tenant['status'],
      planId: (row.plan_id as string) ?? null,
      timezone: (row.timezone as string) ?? 'UTC',
      createdAt: row.created_at as Date,
    };
  }

  private rowToPlan(row: Record<string, unknown>): Plan {
    return {
      id: String(row.id),
      name: String(row.name),
      priceMonthly: parseFloat(String(row.price_monthly)),
      maxDailyEntries: Number(row.max_daily_entries),
      fixedStake: Number(row.fixed_stake),
      fixedTarget: parseFloat(String(row.fixed_target)),
      allowedModes: (row.allowed_modes as string[]) ?? [],
      features: (row.features as Record<string, boolean>) ?? {},
      minStake: Number(row.min_stake ?? row.fixed_stake ?? 700),
      maxStake: Number(row.max_stake ?? row.fixed_stake ?? 700),
      stakeConfigurable: Boolean(row.stake_configurable ?? false),
      billingCycle: (String(row.billing_cycle ?? 'monthly') as Plan['billingCycle']),
    };
  }

  private rowToInstance(row: Record<string, unknown>): TenantInstance {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      containerId: (row.container_id as string) ?? null,
      containerHost: (row.container_host as string) ?? null,
      status: row.status as TenantInstance['status'],
      mode: String(row.mode ?? 'observe-only'),
      dailyEntriesUsed: Number(row.daily_entries_used ?? 0),
      dailyResetAt: (row.daily_reset_at as Date) ?? null,
      pnlToday: parseFloat(String(row.pnl_today ?? 0)),
      pnlTotal: parseFloat(String(row.pnl_total ?? 0)),
      lastHeartbeat: (row.last_heartbeat as Date) ?? null,
    };
  }

  private isNewDay(lastReset: Date, now: Date, timezone: string): boolean {
    const fmt = (d: Date) =>
      d.toLocaleDateString('en-CA', { timeZone: timezone || 'UTC' });
    return fmt(lastReset) !== fmt(now);
  }
}
