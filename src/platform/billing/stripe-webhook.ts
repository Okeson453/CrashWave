/**
 * Stripe webhook — signature verification + full event handling.
 * Uses Node crypto HMAC (no stripe SDK required).
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { getLogger } from '../../observability/logger.js';
import { SubscriptionService } from './subscription-service.js';
import { TenantManager } from '../tenant-manager.js';
import { createContainerOrchestrator } from '../container-orchestrator.js';
import { getPool } from '../../persistence/client.js';

const logger = getLogger();

export function verifyStripeSignature(
  payload: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
  toleranceSec = 300
): boolean {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k, v];
    })
  ) as Record<string, string>;
  const timestamp = parts.t;
  const sig = parts.v1;
  if (!timestamp || !sig) return false;

  const ts = parseInt(timestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;

  const signed = `${timestamp}.${typeof payload === 'string' ? payload : payload.toString('utf8')}`;
  const expected = createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

export async function handleStripeEvent(event: {
  type: string;
  data: { object: Record<string, unknown> };
}): Promise<{ ok: boolean; message?: string }> {
  const subs = new SubscriptionService();
  const tenants = new TenantManager();

  switch (event.type) {
    case 'checkout.session.completed': {
      const obj = event.data.object;
      const userId = String(obj.client_reference_id ?? '');
      const meta = (obj.metadata ?? {}) as Record<string, string>;
      const planId = String(meta.plan_id ?? '');
      const providerSubId =
        typeof obj.subscription === 'string' ? obj.subscription : undefined;
      if (!userId || !planId) {
        return { ok: false, message: 'missing client_reference_id or plan_id' };
      }
      await subs.activate({
        userId,
        planId,
        providerSubscriptionId: providerSubId,
      });
      return { ok: true };
    }

    case 'customer.subscription.updated': {
      const obj = event.data.object;
      const providerSubId = String(obj.id ?? '');
      const status = String(obj.status ?? '');
      if (status === 'active') {
        await getPool().query(
          `UPDATE subscriptions SET status = 'active', updated_at = NOW()
           WHERE payment_provider_subscription_id = $1`,
          [providerSubId]
        );
      } else if (status === 'past_due') {
        await subs.markPastDue(providerSubId);
      }
      return { ok: true };
    }

    case 'customer.subscription.deleted': {
      const obj = event.data.object;
      const providerSubId = String(obj.id ?? '');
      const result = await getPool().query(
        `UPDATE subscriptions SET status = 'cancelled', updated_at = NOW()
         WHERE payment_provider_subscription_id = $1
         RETURNING user_id`,
        [providerSubId]
      );
      const orch = await createContainerOrchestrator();
      for (const row of result.rows) {
        const userId = String(row.user_id);
        await tenants.updateUserStatus(userId, 'cancelled');
        await orch.destroy(userId);
      }
      return { ok: true };
    }

    case 'invoice.payment_failed': {
      const subscriptionId = String(event.data.object.subscription ?? '');
      if (subscriptionId) await subs.markPastDue(subscriptionId);
      return { ok: true };
    }

    case 'invoice.paid': {
      const subscriptionId = String(event.data.object.subscription ?? '');
      if (subscriptionId) {
        await getPool().query(
          `UPDATE subscriptions
           SET status = 'active',
               current_period_end = NOW() + INTERVAL '30 days',
               updated_at = NOW()
           WHERE payment_provider_subscription_id = $1`,
          [subscriptionId]
        );
      }
      return { ok: true };
    }

    default:
      logger.debug({ component: 'StripeWebhook', type: event.type }, 'Ignored event');
      return { ok: true, message: `ignored:${event.type}` };
  }
}

/**
 * HTTP body handler for control-plane server.
 */
export async function processStripeWebhookHttp(params: {
  rawBody: string;
  signatureHeader?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  if (!secret) {
    if (!isDev) {
      return { status: 503, body: { error: 'webhook_secret_not_configured' } };
    }
    logger.warn(
      { component: 'StripeWebhook' },
      'STRIPE_WEBHOOK_SECRET not set — accepting unsigned events (dev only)'
    );
  } else {
    if (!params.signatureHeader) {
      return { status: 400, body: { error: 'missing signature' } };
    }
    const valid = verifyStripeSignature(params.rawBody, params.signatureHeader, secret);
    if (!valid) {
      return { status: 400, body: { error: 'invalid signature' } };
    }
  }

  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(params.rawBody) as typeof event;
  } catch {
    return { status: 400, body: { error: 'invalid json' } };
  }

  const result = await handleStripeEvent(event);
  return {
    status: result.ok ? 200 : 422,
    body: result,
  };
}
