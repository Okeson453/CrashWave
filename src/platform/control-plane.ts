/**
 * Control-plane process — multi-tenant bot + billing webhook + health sweep.
 * Start with: PLATFORM_MODE=control-plane npm run dev
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { getLogger } from '../observability/logger.js';
import { TenantRouterBot } from './telegram-router.js';
import { createContainerOrchestrator, ContainerOrchestrator } from './container-orchestrator.js';
import { processStripeWebhookHttp } from './billing/stripe-webhook.js';
import { processPaystackWebhookHttp } from './payments/webhook-handler.js';
import { VirtualAccountService } from './payments/virtual-account-service.js';
import { DailyBillingWorker } from '../background-workers/daily-billing-worker.js';
import { DailyBillingService } from './billing/daily-billing-service.js';
import { SubscriptionService } from './billing/subscription-service.js';
import { TenantManager } from './tenant-manager.js';

export interface ControlPlaneHandles {
  stop: () => Promise<void>;
}

export async function startControlPlane(): Promise<ControlPlaneHandles> {
  const logger = getLogger();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.includes('REPLACE')) {
    throw new Error('TELEGRAM_BOT_TOKEN required for control-plane mode');
  }

  const orchestrator = await createContainerOrchestrator();
  const bot = new TenantRouterBot(token, orchestrator);
  await bot.start();

  const dailyBilling = new DailyBillingService();
  dailyBilling.setNotify(async (telegramId, message) => {
    await bot.sendMessage(telegramId, message);
  });
  const dailyWorker = new DailyBillingWorker(dailyBilling);
  dailyWorker.start();


  const port = parseInt(process.env.CONTROL_PLANE_PORT ?? '8081', 10);
  const server = createServer((req, res) => {
    void handleHttp(req, res, orchestrator);
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  logger.info({ component: 'ControlPlane', port }, 'Control-plane HTTP listening');

  // Periodic maintenance
  const sweepTimer = setInterval(() => {
    void (async () => {
      try {
        await orchestrator.healthSweep();
        const subs = new SubscriptionService();
        const expired = await subs.expireDueSubscriptions();
        if (expired > 0) {
          logger.info({ component: 'ControlPlane', expired }, 'Expired subscriptions cleaned');
        }
      } catch (err) {
        logger.error({ component: 'ControlPlane', error: String(err) }, 'Sweep failed');
      }
    })();
  }, 60_000);
  if (typeof sweepTimer === 'object' && 'unref' in sweepTimer) {
    (sweepTimer as NodeJS.Timeout).unref();
  }

  return {
    stop: async () => {
      clearInterval(sweepTimer);
      dailyWorker.stop();
      await bot.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  orchestrator: ContainerOrchestrator
): Promise<void> {
  const logger = getLogger();
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  try {
    if (method === 'GET' && (url === '/health' || url === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: 'control-plane' }));
      return;
    }

    if (method === 'POST' && url === '/webhooks/stripe') {
      const rawBody = await readBody(req);
      const result = await processStripeWebhookHttp({
        rawBody,
        signatureHeader: req.headers['stripe-signature'] as string | undefined,
      });
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
      return;
    }

    if (method === 'POST' && (url === '/webhooks/paystack' || url === '/paystack')) {
      const rawBody = await readBody(req);
      const result = await processPaystackWebhookHttp({
        rawBody,
        signatureHeader: req.headers['x-paystack-signature'] as string | undefined,
      });
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
      return;
    }

    // Admin API (bearer token)
    if (url.startsWith('/admin/')) {
      const adminToken = process.env.ADMIN_API_TOKEN;
      const auth = req.headers.authorization ?? '';
      if (!adminToken || auth !== `Bearer ${adminToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      await handleAdminApi(method, url, req, res, orchestrator);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    logger.error({ component: 'ControlPlane', error: String(err) }, 'HTTP handler error');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal' }));
  }
}

async function handleAdminApi(
  method: string,
  url: string,
  _req: IncomingMessage,
  res: ServerResponse,
  orchestrator: ContainerOrchestrator
): Promise<void> {
  const tenants = new TenantManager();

  if (method === 'GET' && url === '/admin/users') {
    const { getPool } = await import('../persistence/client.js');
    const q = await getPool().query(
      `SELECT u.id, u.telegram_id, u.telegram_username, u.status, u.plan_id,
              p.name AS plan_name, i.status AS engine_status, i.pnl_total, i.daily_entries_used
       FROM users u
       LEFT JOIN plans p ON u.plan_id = p.id
       LEFT JOIN tenant_instances i ON u.id = i.user_id
       ORDER BY u.created_at DESC
       LIMIT 200`
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ users: q.rows }));
    return;
  }

  if (method === 'POST' && url === '/admin/pause-all') {
    await orchestrator.globalPause();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'POST' && url === '/admin/resume-all') {
    await orchestrator.globalResume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'POST' && url.startsWith('/admin/provision/')) {
    const userId = url.split('/').pop()!;
    const plan = await tenants.getUserById(userId).then(async (u) =>
      u?.planId ? tenants.getPlan(u.planId) : null
    );
    const info = await orchestrator.provision(userId, plan
      ? {
          FIXED_STAKE: String(plan.fixedStake),
          FIXED_TARGET: String(plan.fixedTarget),
          MAX_DAILY_ENTRIES: String(plan.maxDailyEntries),
        }
      : undefined);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(info));
    return;
  }

  if (method === 'POST' && url.startsWith('/admin/destroy/')) {
    const userId = url.split('/').pop()!;
    await orchestrator.destroy(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'GET' && url === '/admin/plans') {
    const plans = await tenants.listActivePlans();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ plans }));
    return;
  }

  if (method === 'GET' && url === '/admin/instances') {
    const { getPool } = await import('../persistence/client.js');
    const q = await getPool().query(
      `SELECT i.*, u.telegram_username, u.telegram_id, u.status AS user_status
       FROM tenant_instances i
       JOIN users u ON u.id = i.user_id
       ORDER BY i.updated_at DESC
       LIMIT 200`
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ instances: q.rows }));
    return;
  }

  if (method === 'GET' && url === '/admin/audit') {
    const { getPool } = await import('../persistence/client.js');
    const q = await getPool().query(
      `SELECT * FROM platform_audit_logs ORDER BY created_at DESC LIMIT 100`
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ logs: q.rows }));
    return;
  }

  if (method === 'POST' && url.startsWith('/admin/verify-payment/')) {
    const txId = url.split('/').pop()!;
    const va = new VirtualAccountService();
    await va.verifyPendingTransaction(txId, 'admin-api');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'GET' && url === '/admin/overview') {
    const { getPool } = await import('../persistence/client.js');
    const q = await getPool().query(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users_total,
         (SELECT COUNT(*) FROM users WHERE status = 'active') AS users_active,
         (SELECT COUNT(*) FROM tenant_instances WHERE status = 'running') AS engines_running,
         (SELECT COUNT(*) FROM tenant_instances WHERE status = 'error') AS engines_error,
         (SELECT COUNT(*) FROM subscriptions WHERE status = 'active') AS subs_active,
         (SELECT COALESCE(SUM(pnl_total),0) FROM tenant_instances) AS pnl_total
      `
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(q.rows[0] ?? {}));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}
