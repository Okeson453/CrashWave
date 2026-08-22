/**
 * VirtualAccountService — per-user Paystack DVAs, payment log, subscription activation.
 */

import { getPool } from '../../persistence/client.js';
import { getLogger } from '../../observability/logger.js';
import { TenantManager } from '../tenant-manager.js';
import {
  createContainerOrchestrator,
  ContainerOrchestrator,
} from '../container-orchestrator.js';
import { Plan } from '../types.js';

import { PaystackClient } from './paystack-client.js';

export interface VirtualAccount {
  id: string;
  userId: string;
  accountNumber: string;
  bankName: string;
  bankCode: string;
  accountName: string;
  isActive: boolean;
  paystackCustomerId: string;
}

export type NotifyFn = (
  telegramId: bigint,
  message: string
) => Promise<void>;

export class VirtualAccountService {
  private readonly logger = getLogger();
  private readonly paystack: PaystackClient;
  private readonly tenants = new TenantManager();
  private orchestrator: ContainerOrchestrator | null = null;
  private notify: NotifyFn | null;

  constructor(opts?: { paystack?: PaystackClient; notify?: NotifyFn }) {
    this.paystack = opts?.paystack ?? new PaystackClient();
    this.notify = opts?.notify ?? null;
  }

  setNotify(fn: NotifyFn): void {
    this.notify = fn;
  }

  private async orch(): Promise<ContainerOrchestrator> {
    if (!this.orchestrator) {this.orchestrator = await createContainerOrchestrator();}
    return this.orchestrator;
  }

  async createVirtualAccountForUser(
    userId: string,
    _plan?: { name: string; priceMonthly: number }
  ): Promise<VirtualAccount> {
    const user = await this.tenants.getUserById(userId);
    if (!user) {throw new Error('User not found');}

    const existing = await this.getVirtualAccount(userId);
    if (existing) {
      this.logger.info({ component: 'VirtualAccountService', userId }, 'Reusing virtual account');
      return existing;
    }

    const firstName = (user.telegramUsername ?? 'User').slice(0, 40);
    const lastName = String(user.telegramId).slice(-6);
    const email =
      user.email ?? `tg-${user.telegramId}@paystack-tenant.local`;

    const customer = await this.paystack.createCustomer({
      email,
      firstName,
      lastName,
      phone: process.env.PAYSTACK_PLACEHOLDER_PHONE ?? '08000000000',
    });

    const dva = await this.paystack.createDedicatedVirtualAccount({
      customerCode: customer.customer_code,
      firstName,
      lastName,
      phone: process.env.PAYSTACK_PLACEHOLDER_PHONE ?? '08000000000',
    });

    const result = await getPool().query(
      `INSERT INTO virtual_accounts (
         user_id, paystack_customer_id, paystack_customer_code, paystack_dva_id,
         account_number, bank_name, bank_code, account_name
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        userId,
        String(customer.id),
        customer.customer_code,
        String(dva.id),
        dva.account_number,
        dva.bank?.name ?? 'Unknown',
        dva.bank?.slug ?? '',
        dva.account_name,
      ]
    );

    const va = this.rowToVa(result.rows[0] as Record<string, unknown>);
    await this.tenants.audit({
      actorType: 'system',
      action: 'virtual_account.created',
      targetUserId: userId,
      payload: { accountNumber: va.accountNumber, bank: va.bankName },
    });
    this.logger.info(
      { component: 'VirtualAccountService', userId, accountNumber: va.accountNumber },
      'Virtual account created'
    );
    return va;
  }

  async getVirtualAccount(userId: string): Promise<VirtualAccount | null> {
    const result = await getPool().query(
      `SELECT * FROM virtual_accounts WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [userId]
    );
    if (result.rows.length === 0) {return null;}
    return this.rowToVa(result.rows[0] as Record<string, unknown>);
  }

  async findByCustomerId(customerId: string): Promise<VirtualAccount | null> {
    const result = await getPool().query(
      `SELECT * FROM virtual_accounts
       WHERE (paystack_customer_id = $1 OR paystack_customer_code = $1)
         AND is_active = true
       LIMIT 1`,
      [customerId]
    );
    if (result.rows.length === 0) {return null;}
    return this.rowToVa(result.rows[0] as Record<string, unknown>);
  }

  async handleTransferSuccess(payload: {
    reference: string;
    amount: number; // kobo
    paid_at?: string | null;
    channel?: string;
    bank_name?: string;
    bank_account?: string;
    narration?: string;
    customer?: { id?: number; customer_code?: string };
    metadata?: Record<string, unknown>;
  }): Promise<{ ok: boolean; userId?: string; reason?: string }> {
    const amountNaira = payload.amount / 100;
    const reference = payload.reference;
    if (!reference) {
      return { ok: false, reason: 'missing_reference' };
    }

    const customerKey =
      (payload.customer?.customer_code ? String(payload.customer.customer_code) : '') ||
      (payload.customer?.id !== undefined && payload.customer?.id !== null
        ? String(payload.customer.id)
        : '');

    let va: VirtualAccount | null = null;
    if (customerKey) {
      va = await this.findByCustomerId(customerKey);
    }
    if (!va && payload.metadata?.user_id !== undefined) {
      const mid = payload.metadata['user_id'];
      const midStr =
        typeof mid === 'string' || typeof mid === 'number' ? String(mid) : '';
      if (midStr) {
        va = await this.getVirtualAccount(midStr);
      }
    }
    if (!va) {
      this.logger.error(
        { component: 'VirtualAccountService', customerKey, reference },
        'No virtual account for payment'
      );
      return { ok: false, reason: 'va_not_found' };
    }

    const userId = va.userId;
    const user = await this.tenants.getUserById(userId);
    const plan = user?.planId ? await this.tenants.getPlan(user.planId) : null;
    if (!plan) {
      this.logger.error({ component: 'VirtualAccountService', userId }, 'No plan on user');
      return { ok: false, userId, reason: 'no_plan' };
    }

    const expected = Number(plan.priceMonthly);
    if (amountNaira < expected) {
      this.logger.error(
        {
          component: 'VirtualAccountService',
          userId,
          expected,
          received: amountNaira,
        },
        'Underpayment — subscription NOT activated'
      );
      await getPool().query(
        `INSERT INTO payment_transactions (
           user_id, virtual_account_id, paystack_reference, amount, currency, status,
           paid_at, channel, narration, metadata
         ) VALUES ($1,$2,$3,$4,'NGN','failed',NOW(),$5,'underpayment',$6)
         ON CONFLICT (paystack_reference) DO UPDATE
           SET status = 'failed', metadata = EXCLUDED.metadata
           WHERE payment_transactions.status <> 'success'`,
        [
          userId,
          va.id,
          reference,
          amountNaira,
          payload.channel ?? 'bank_transfer',
          JSON.stringify({ expected, received: amountNaira }),
        ]
      );
      return { ok: false, userId, reason: 'underpayment' };
    }

    // Atomic claim: first writer wins via unique paystack_reference
    const claim = await getPool().query(
      `INSERT INTO payment_transactions (
         user_id, virtual_account_id, paystack_reference, amount, currency, status,
         paid_at, channel, bank_name, bank_account, narration, metadata
       ) VALUES ($1,$2,$3,$4,'NGN','success',$5,$6,$7,$8,$9,$10)
       ON CONFLICT (paystack_reference) DO NOTHING
       RETURNING id`,
      [
        userId,
        va.id,
        reference,
        amountNaira,
        payload.paid_at ?? new Date().toISOString(),
        payload.channel ?? 'bank_transfer',
        payload.bank_name ?? null,
        payload.bank_account ?? null,
        payload.narration ?? null,
        JSON.stringify(payload.metadata ?? {}),
      ]
    );

    if (claim.rows.length === 0) {
      // Another concurrent webhook already claimed this reference
      return { ok: true, userId, reason: 'already_processed' };
    }

    await this.activateSubscription(userId, plan, reference);
    await this.notifyUserPaymentSuccess(userId, amountNaira, plan.name);
    return { ok: true, userId };
  }

  async handleTransferFailed(payload: {
    reference: string;
    amount?: number;
  }): Promise<void> {
    await getPool().query(
      `UPDATE payment_transactions SET status = 'failed' WHERE paystack_reference = $1`,
      [payload.reference]
    );
    this.logger.warn(
      { component: 'VirtualAccountService', reference: payload.reference },
      'Transfer failed/reversed'
    );
  }

  async activateSubscription(
    userId: string,
    plan: Plan,
    providerRef: string
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO subscriptions (
         user_id, plan_id, status, current_period_start, current_period_end,
         payment_provider, payment_provider_subscription_id
       ) VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '1 month', 'paystack', $3)`,
      [userId, plan.id, providerRef]
    );
    await this.tenants.assignPlan(userId, plan.id);
    await this.tenants.updateUserStatus(userId, 'active');

    const orch = await this.orch();
    await orch.provision(userId, {
      FIXED_STAKE: String(plan.fixedStake),
      FIXED_TARGET: String(plan.fixedTarget),
      MAX_DAILY_ENTRIES: String(plan.maxDailyEntries),
      MODE: 'observe-only',
    });

    await this.tenants.audit({
      actorType: 'billing',
      action: 'subscription.activated.paystack',
      targetUserId: userId,
      payload: { planId: plan.id, reference: providerRef },
    });

    this.logger.info(
      { component: 'VirtualAccountService', userId, plan: plan.name },
      'Subscription activated via Paystack transfer'
    );
  }

  async createPendingTransaction(
    userId: string,
    amount: number,
    reference: string
  ): Promise<string> {
    const result = await getPool().query(
      `INSERT INTO payment_transactions (user_id, amount, currency, status, paystack_reference)
       VALUES ($1, $2, 'NGN', 'pending', $3)
       RETURNING id`,
      [userId, amount, reference]
    );
    return String((result.rows[0] as { id: string }).id);
  }

  async verifyPendingTransaction(
    txId: string,
    adminActorId: string
  ): Promise<void> {
    const result = await getPool().query(
      `SELECT * FROM payment_transactions WHERE id = $1`,
      [txId]
    );
    if (result.rows.length === 0) {throw new Error('Transaction not found');}
    const tx = result.rows[0] as {
      user_id: string;
      amount: string;
      status: string;
    };

    await getPool().query(
      `UPDATE payment_transactions SET status = 'success', paid_at = NOW() WHERE id = $1`,
      [txId]
    );

    const user = await this.tenants.getUserById(tx.user_id);
    const plan = user?.planId ? await this.tenants.getPlan(user.planId) : null;
    if (!plan) {throw new Error('User has no plan');}

    await this.activateSubscription(tx.user_id, plan, `manual:${txId}`);
    await this.notifyUserPaymentSuccess(
      tx.user_id,
      parseFloat(tx.amount),
      plan.name
    );
    await this.tenants.audit({
      actorType: 'admin',
      actorId: adminActorId,
      action: 'manual_payment_verified',
      targetUserId: tx.user_id,
      payload: { transactionId: txId, amount: tx.amount },
    });
  }

  async hasActiveSubscription(userId: string): Promise<boolean> {
    const result = await getPool().query(
      `SELECT 1 FROM subscriptions WHERE user_id = $1 AND status = 'active' LIMIT 1`,
      [userId]
    );
    return result.rows.length > 0;
  }

  private async notifyUserPaymentSuccess(
    userId: string,
    amount: number,
    planName: string
  ): Promise<void> {
    const user = await this.tenants.getUserById(userId);
    if (!user || !this.notify) {return;}
    const msg =
      `✅ *Payment Received!*\n\n` +
      `Amount: ₦${amount.toLocaleString()}\n` +
      `Plan: ${planName}\n\n` +
      `Your engine is being provisioned.\n` +
      `Next: /setup_creds to add BC.Game credentials.`;
    try {
      await this.notify(user.telegramId, msg);
    } catch (err) {
      this.logger.warn(
        { component: 'VirtualAccountService', error: String(err) },
        'Telegram notify failed'
      );
    }
  }

  private rowToVa(row: Record<string, unknown>): VirtualAccount {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      accountNumber: String(row.account_number),
      bankName: String(row.bank_name),
      bankCode: typeof row.bank_code === 'string' || typeof row.bank_code === 'number' ? String(row.bank_code) : '',
      accountName: String(row.account_name),
      isActive: Boolean(row.is_active),
      paystackCustomerId: String(row.paystack_customer_id),
    };
  }
}
