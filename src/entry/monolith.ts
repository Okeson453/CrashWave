/**
 * Personal-Use Monolith Entry Point
 *
 * This is the single process that the spec calls "monolith.ts":
 *   - Loads config (YAML + .env)
 *   - Boots the pg pool (and optional Redis client)
 *   - Builds the composition (orchestrator, dry-run controller, telegram
 *     gateway, worker fleet, metrics server)
 *   - Starts the metrics + /health HTTP server on METRICS_PORT
 *   - Starts the Telegram bot
 *   - Starts the orchestrator (browser + game adapter, only in live mode)
 *   - Hooks SIGTERM/SIGINT for graceful shutdown
 *
 * This replaces the multi-process dispatch in src/index.ts and the
 * API/websocket/mini-app wiring that the spec explicitly removes.
 */

import http from 'http';
import { register } from 'prom-client';

import { bootConfig, bootPersistence } from './shared-boot';
import { composeApplication, setGlobalComposition } from '../app/composition';
import { getLogger } from '../observability/logger';
import { installCrashHandlers } from '../utils/crash-handler';

export async function main(): Promise<void> {
  installCrashHandlers();
  const config = bootConfig();
  bootPersistence(config, { requireRedis: false });

  const { ctx, start, stop } = composeApplication(config);
  setGlobalComposition({ ctx, start, stop });

  const logger = getLogger();
  const metricsPort = Number(process.env.METRICS_PORT ?? 9090);

  const metricsServer = http.createServer(async (req, res) => {
    try {
      if (req.url === '/health') {
        // Lightweight health: green if dry-run is running and no halt.
        const halted = Boolean(ctx.runtime?.halted);
        const status = halted ? 503 : 200;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: halted ? 'unhealthy' : 'healthy',
          role: 'monolith',
          version: '1.0.0-personal',
          mode: config.system.mode,
        }));
        return;
      }
      if (req.url === '/state') {
        // Read-only JSON snapshot of orchestrator state (spec §5.3).
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          mode: config.system.mode,
          sessionId: ctx.runtime?.sessionId ?? null,
          dryRun: ctx.dryRunController?.isRunning() ?? false,
        }));
        return;
      }
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': register.contentType });
        res.end(await register.metrics());
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (e) {
      logger.error({ component: 'Monolith', error: String(e) }, 'metrics server error');
      res.writeHead(500);
      res.end('Internal error');
    }
  });

  await start();
  metricsServer.listen(metricsPort, () => {
    logger.info({ port: metricsPort, mode: config.system.mode }, 'Metrics server listening (GET /health, /metrics, /state)');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down monolith');
    try { metricsServer.close(); } catch { /* */ }
    try { await stop(); } catch (e) { logger.warn({ error: String(e) }, 'compose.stop error'); }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
