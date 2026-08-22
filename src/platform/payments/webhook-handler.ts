/**
 * Paystack webhook — routes to monthly, daily, or stake-fee activation.
 */

import { getLogger } from '../../observability/logger.js';
import { getPool } from '../../persistence/client.js';
import { DailyBillingService } from '../billing/daily-billing-service.js';
import { StakeConfigurationService } from '../stake/stake-config-service.js';
import { TenantManager } from '../tenant-manager.js';

import { PaystackClient } from './paystack-client.js';
import { VirtualAccountService } from './virtual-account-service.js';

const logger = getLogger();

function asString(value: unknown): string {
  if (typeof value === 'string') {return value;}
  if (typeof value === 'number' || typeof value === 'boolean') {return String(value);}
  return '';
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {return value;}
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export async function processPaystackWebhookHttp(params: {
  rawBody: string;
  signatureHeader?: string;
  vaService?: VirtualAccountService;
  paystack?: PaystackClient;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  let paystack = params.paystack;
  if (!paystack) {
    try {
      paystack = new PaystackClient();
    } catch {
      return { status: 503, body: { error: 'paystack_not_configured' } };
    }
  }

  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  const skipVerify = isDev && process.env.PAYSTACK_SKIP_SIGNATURE === '1';
  if (!params.signatureHeader && !skipVerify) {
    return { status: 401, body: { error: 'missing_signature' } };
  }
  if (
    !skipVerify &&
    !paystack.verifyWebhookSignature(params.rawBody, params.signatureHeader)
  ) {
    return { status: 401, body: { error: 'invalid_signature' } };
  }

  let event: { event?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(params.rawBody) as typeof event;
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }

  const eventType = asString(event.event);
  const data = event.data ?? {};
  const vaService = params.vaService ?? new VirtualAccountService();
  const tenants = new TenantManager();
  const stakeService = new StakeConfigurationService();
  const dailyBilling = new DailyBillingService();

  logger.info(
    { component: 'PaystackWebhook', eventType, reference: data.reference },
    'Paystack event'
  );

  try {
    if (eventType === 'charge.success') {
      const amountKobo = asNumber(data.amount) ?? 0;
      const amountNaira = amountKobo / 100;
      const reference = asString(data.reference);
      const customer = (data.customer ?? {}) as {
        id?: number;
        customer_code?: string;
      };
      const auth = (data.authorization ?? {}) as Record<string, unknown>;

      const customerKey =
        asString(customer.customer_code) ||
        (customer.id !== undefined && customer.id !== null ? String(customer.id) : '');

      let userId: string | null = null;
      if (customerKey) {
        const va = await vaService.findByCustomerId(customerKey);
        userId = va?.userId ?? null;
      }
      if (!userId) {
        const mid = (data.metadata as { user_id?: unknown } | undefined)?.user_id;
        const midStr = asString(mid);
        if (midStr) {userId = midStr;}
      }
      if (!userId) {
        logger.error({ component: 'PaystackWebhook', customerKey }, 'No user for payment');
        return { status: 200, body: { received: true, warning: 'user_not_found' } };
      }

      const user = await tenants.getUserById(userId);
      const plan = user?.planId ? await tenants.getPlan(user.planId) : null;

      const stakeConfig = await stakeService.getStakeConfig(userId);
      if (
        stakeConfig &&
        !stakeConfig.increasePaid &&
        stakeConfig.isConfigurable &&
        amountNaira >= stakeConfig.increaseFeeAmount &&
        Math.abs(amountNaira - stakeConfig.increaseFeeAmount) <
          Math.abs(amountNaira - (plan?.priceMonthly ?? Number.POSITIVE_INFINITY))
      ) {
        await stakeService.processStakeIncreasePayment(userId, reference);
        return { status: 200, body: { received: true, kind: 'stake_fee' } };
      }

      if (plan?.billingCycle === 'daily') {
        await dailyBilling.activateDailySubscription({
          userId,
          planId: plan.id,
          reference,
          amount: amountNaira,
        });
        await getPool().query(
          `INSERT INTO payment_transactions (
             user_id, paystack_reference, amount, currency, status, paid_at, channel
           ) VALUES ($1, $2, $3, 'NGN', 'success', NOW(), 'daily_subscription')
           ON CONFLICT (paystack_reference) DO NOTHING`,
          [userId, reference, amountNaira]
        );
        return { status: 200, body: { received: true, kind: 'daily' } };
      }

      await vaService.handleTransferSuccess({
        reference,
        amount: amountKobo,
        paid_at: typeof data.paid_at === 'string' ? data.paid_at : null,
        channel: asString(data.channel) || 'bank_transfer',
        bank_name: asString(auth.bank) || undefined,
        bank_account: asString(auth.last4) || undefined,
        narration: 'Subscription',
        customer,
        metadata: (data.metadata as Record<string, unknown>) ?? {},
      });
      return { status: 200, body: { received: true, kind: 'monthly' } };
    }

    if (eventType === 'transfer.failed' || eventType === 'charge.reversed') {
      await vaService.handleTransferFailed({
        reference: asString(data.reference),
        amount: asNumber(data.amount),
      });
    }
  } catch (err) {
    logger.error(
      { component: 'PaystackWebhook', error: String(err) },
      'Webhook processing error'
    );
  }

  return { status: 200, body: { received: true } };
}
