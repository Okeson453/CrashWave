/**
 * DailyBillingService — Pay-as-You-Go daily subscriptions.
 */

import { getPool } from '../../persistence/client.js';
import { getLogger } from '../../observability/logger.js';
import { TenantManager } from '../tenant-manager.js';
import {
  createContainerOrchestrator,
  ContainerOrchestrator,
} from '../container-orchestrator.js';
import { VirtualAccountService } from '../payments/virtual-account-service.js';

export interface DailySubscription {
  id: string;
  userId: string;
  planId: string;
  status: 'active' | 'expired' | 'renewing' | 'paused';
  paidDate: string;
  paidAt: Date | null;
  expiresAt: Date | null;
  autoRenew: boolean;
}

export type NotifyFn = (telegramId: bigint, message: string) => Promise<void>;

export class DailyBillingService {
  private readonly logger = getLogger();
  private readonly tenants = new TenantManager();
  private readonly vaService = new VirtualAccountService();
  private orchestrator: ContainerOrchestrator | null = null;
  private notify: NotifyFn | null = null;

  readonly dailyPrice = parseInt(process.env.DAILY_PLAN_PRICE_NGN ?? '2000', 10);
  readonly gracePeriodMinutes = parseInt(
    process.env.DAILY_GRACE_PERIOD_MINUTES ?? '30',
    10
  );

  setNotify(fn: NotifyFn): void {
    this.notify = fn;
  }

  private async orch(): Promise<ContainerOrchestrator> {
    if (!this.orchestrator) this.orchestrator = await createContainerOrchestrator();
    return this.orchestrator;
  }

  async getTodaySubscription(userId: string): Promise<DailySubscription | null> {
    const result = await getPool().query(
      `SELECT * FROM daily_subscriptions
       WHERE user_id = $1 AND paid_date = CURRENT_DATE
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (result.rows.length === 0) return null;
    return this.rowToDailySub(result.rows[0]);
  }

  async activateDailySubscription(params: {
    userId: string;
    planId: string;
    reference: string;
    amount: number;
  }): Promise<{ success: boolean; message: string; expiresAt: Date }> {
    if (params.amount + 0.01 < this.dailyPrice) {
      return {
        success: false,
        message: `Insufficient payment. Required: ${this.dailyPrice}, Received: ${params.amount}`,
        expiresAt: new Date(),
      };
    }

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    await getPool().query(
      `INSERT INTO daily_subscriptions (
         user_id, plan_id, status, paid_date, paid_at, expires_at, payment_reference
       ) VALUES ($1, $2, 'active', CURRENT_DATE, NOW(), $3, $4)
       ON CONFLICT (user_id, paid_date) DO UPDATE SET
         status = 'active',
         paid_at = NOW(),
         expires_at = EXCLUDED.expires_at,
         payment_reference = EXCLUDED.payment_reference`,
      [params.userId, params.planId, tomorrow, params.reference]
    );

    await this.tenants.assignPlan(params.userId, params.planId);
    await this.tenants.updateUserStatus(params.userId, 'active');

    const instance = await this.tenants.getInstance(params.userId);
    const plan = await this.tenants.getPlan(params.planId);
    if ((!instance || instance.status !== 'running') && plan) {
      const orch = await this.orch();
      await orch.provision(params.userId, {
        FIXED_STAKE: String(plan.fixedStake),
        FIXED_TARGET: String(plan.fixedTarget),
        MAX_DAILY_ENTRIES: String(plan.maxDailyEntries),
        MODE: 'observe-only',
      });
    }

    this.logger.info(
      {
        component: 'DailyBilling',
        userId: params.userId,
        amount: params.amount,
        expiresAt: tomorrow,
      },
      'Daily subscription activated'
    );

    return {
      success: true,
      message: `Daily access activated until midnight.`,
      expiresAt: tomorrow,
    };
  }

  async expireOverdueSubscriptions(): Promise<
    Array<{ userId: string; telegramId: bigint }>
  > {
    const result = await getPool().query(
      `SELECT ds.user_id, u.telegram_id, ds.paid_date
       FROM daily_subscriptions ds
       JOIN users u ON ds.user_id = u.id
       WHERE ds.status = 'active'
         AND ds.expires_at < NOW() - ($1 || ' minutes')::INTERVAL`,
      [String(this.gracePeriodMinutes)]
    );

    const expired: Array<{ userId: string; telegramId: bigint }> = [];
    const orch = await this.orch();
    for (const row of result.rows) {
      await getPool().query(
        `UPDATE daily_subscriptions SET status = 'expired'
         WHERE user_id = $1 AND paid_date = $2`,
        [row.user_id, row.paid_date]
      );
      try {
        await orch.pause(String(row.user_id));
      } catch {
        /* ignore */
      }
      expired.push({
        userId: String(row.user_id),
        telegramId: BigInt(String(row.telegram_id)),
      });
    }
    return expired;
  }

  async sendRenewalReminders(): Promise<number> {
    const result = await getPool().query(
      `SELECT ds.user_id, u.telegram_id, ds.expires_at
       FROM daily_subscriptions ds
       JOIN users u ON ds.user_id = u.id
       WHERE ds.status = 'active'
         AND ds.expires_at BETWEEN NOW() AND NOW() + INTERVAL '2 hours'
         AND ds.auto_renew = true
         AND NOT EXISTS (
           SELECT 1 FROM daily_billing_reminders dbr
           WHERE dbr.user_id = ds.user_id
             AND dbr.reminder_type = 'evening'
             AND dbr.sent_at > ds.paid_at
         )`
    );
    let sent = 0;
    for (const row of result.rows) {
      const va = await this.vaService.getVirtualAccount(String(row.user_id));
      const expiresAt = new Date(row.expires_at);
      const timeLeft = Math.max(
        0,
        Math.ceil((expiresAt.getTime() - Date.now()) / 60000)
      );
      if (this.notify) {
        await this.notify(
          BigInt(String(row.telegram_id)),
          `⏰ *Daily Access Expiring Soon*\n\n` +
            `Expires in ~${timeLeft} minutes.\n\n` +
            `Transfer *₦${this.dailyPrice.toLocaleString()}* to continue:\n` +
            `Bank: *${va?.bankName ?? 'Wema Bank'}*\n` +
            `Account: \`${va?.accountNumber ?? '—'}\``
        );
      }
      await getPool().query(
        `INSERT INTO daily_billing_reminders (user_id, reminder_type) VALUES ($1, 'evening')`,
        [row.user_id]
      );
      sent++;
    }
    return sent;
  }

  async sendMorningReminders(): Promise<number> {
    const result = await getPool().query(
      `SELECT u.id AS user_id, u.telegram_id
       FROM users u
       JOIN plans p ON u.plan_id = p.id
       WHERE p.billing_cycle = 'daily'
         AND u.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM daily_subscriptions ds
           WHERE ds.user_id = u.id AND ds.paid_date = CURRENT_DATE AND ds.status = 'active'
         )
         AND NOT EXISTS (
           SELECT 1 FROM daily_billing_reminders dbr
           WHERE dbr.user_id = u.id
             AND dbr.reminder_type = 'morning'
             AND dbr.sent_at::date = CURRENT_DATE
         )`
    );
    let sent = 0;
    for (const row of result.rows) {
      const va = await this.vaService.getVirtualAccount(String(row.user_id));
      if (this.notify) {
        await this.notify(
          BigInt(String(row.telegram_id)),
          `🌅 *Good Morning!*\n\n` +
            `Pay-as-You-Go is inactive for today.\n` +
            `Transfer *₦${this.dailyPrice.toLocaleString()}* to:\n` +
            `Bank: *${va?.bankName ?? 'Wema Bank'}*\n` +
            `Account: \`${va?.accountNumber ?? '—'}\``
        );
      }
      await getPool().query(
        `INSERT INTO daily_billing_reminders (user_id, reminder_type) VALUES ($1, 'morning')`,
        [row.user_id]
      );
      sent++;
    }
    return sent;
  }

  async toggleAutoRenew(userId: string, enabled: boolean): Promise<void> {
    await getPool().query(
      `UPDATE daily_subscriptions SET auto_renew = $1
       WHERE user_id = $2 AND paid_date = CURRENT_DATE`,
      [enabled, userId]
    );
  }

  private rowToDailySub(row: Record<string, unknown>): DailySubscription {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      planId: String(row.plan_id),
      status: row.status as DailySubscription['status'],
      paidDate: String(row.paid_date),
      paidAt: (row.paid_at as Date) ?? null,
      expiresAt: (row.expires_at as Date) ?? null,
      autoRenew: Boolean(row.auto_renew),
    };
  }
}
