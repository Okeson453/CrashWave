import dotenv from 'dotenv';
dotenv.config();
import { hydrateSecretsFromFiles } from './config/secret-files';
hydrateSecretsFromFiles();

import { validateConfig } from './config/validator';
import { createLogger, getLogger } from './observability/logger';
import { createEventBus, getEventBus } from './core/event-bus/bus';
import { createPool, closePool, healthCheck as dbHealthCheck } from './persistence/client';
import { createRedisClient, getRedisClient, closeRedisClient, redisHealthCheck } from './persistence/redis-client';
import { HealthMonitor } from './observability/health/monitor';
import { DatabaseHealthCheck, RedisHealthCheck, StaticHealthCheck } from './observability/health/checks';
import { createServer } from 'http';
import { getMetrics, getMetricsContentType } from './observability/metrics/registry';
import { composeApplication, CompositionHandles } from './app/composition';
import { startControlPlane, ControlPlaneHandles } from './platform/control-plane';
import { startHeartbeatLoop } from './platform/heartbeat';
import { applyTenantDbContext } from './platform/tenant-context';

let isShuttingDown = false;
let composition: CompositionHandles | null = null;
let controlPlane: ControlPlaneHandles | null = null;
let stopHeartbeat: (() => void) | null = null;

async function bootstrap(): Promise<void> {
  try {
    const config = validateConfig();
    createLogger(config.system.serviceName, config.system.logLevel);
    const logger = getLogger();
    logger.info({ component: 'Bootstrap' }, 'Starting BC.Game Crash Automation & Analytics System');

    createEventBus();
    logger.info({ component: 'Bootstrap' }, 'Event bus initialized');

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    createPool({
      connectionString: dbUrl,
      poolSize: config.persistence.databasePoolSize,
    });
    const dbHealthy = await dbHealthCheck();
    if (!dbHealthy) {
      throw new Error('Database health check failed');
    }
    logger.info({ component: 'Bootstrap' }, 'Database connected');

    // Multi-tenant RLS session (no-op when TENANT_ID unset)
    await applyTenantDbContext();

    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      createRedisClient({
        url: redisUrl,
        commandTimeoutMs: config.persistence.redisCommandTimeoutMs,
        reconnectIntervalMs: config.persistence.redisReconnectIntervalMs,
      });
      const redis = getRedisClient();
      await redis.connect();
      const redisHealthy = await redisHealthCheck();
      if (!redisHealthy) {
        throw new Error('Redis health check failed');
      }
      logger.info({ component: 'Bootstrap' }, 'Redis connected');
    } else {
      logger.warn({ component: 'Bootstrap' }, 'REDIS_URL not set, running without Redis');
    }

    const healthMonitor = new HealthMonitor({
      intervalMs: config.health.checkIntervalMs,
      degradationThreshold: config.health.degradationThreshold,
      failureThreshold: config.health.failureThreshold,
    });
    healthMonitor.registerCheck(new DatabaseHealthCheck(dbHealthCheck));
    if (redisUrl) {
      healthMonitor.registerCheck(new RedisHealthCheck(redisHealthCheck));
    }
    healthMonitor.registerCheck(new StaticHealthCheck('app', 'OK', 'Application is running'));
    healthMonitor.start();

    // Railway sets PORT; prefer it so platform healthchecks hit /health.
    // METRICS_PORT remains available for local/docker dual-port setups.
    const metricsPort = parseInt(
      process.env.PORT || process.env.METRICS_PORT || '9090',
      10
    );
    const metricsServer = createServer(async (req, res) => {
      if (req.url === '/metrics') {
        res.setHeader('Content-Type', getMetricsContentType());
        res.end(await getMetrics());
      } else if (req.url === '/health' || req.url === '/healthz') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', mode: config.system.mode }));
      } else {
        res.statusCode = 404;
        res.end('Not Found');
      }
    });
    metricsServer.listen(metricsPort, () => {
      logger.info({ component: 'Bootstrap', port: metricsPort }, 'Metrics/health server listening');
    });

    // Control-plane mode: multi-tenant bot + billing webhooks (no local engine)
    if ((process.env.PLATFORM_MODE ?? '').toLowerCase() === 'control-plane') {
      controlPlane = await startControlPlane();
      logger.info({ component: 'Bootstrap' }, 'Control plane started');
      return;
    }

    // Composition root: recovery, supervisor, telegram, canary, instance lock
    composition = composeApplication(config, { healthMonitor });
    await composition.start();

    // Tenant engine heartbeat when running under TENANT_ID
    stopHeartbeat = startHeartbeatLoop(60_000);

    const eventBus = getEventBus();
    await eventBus.emitTyped(
      'BrowserStarted',
      {
        sessionId: 'system',
        headless: config.browser.headless,
      },
      'bootstrap',
      'system'
    );

    logger.info({ component: 'Bootstrap' }, 'System startup complete');
    logger.info({ component: 'Bootstrap' }, `Mode: ${config.system.mode.toUpperCase()}`);
    logger.info({ component: 'Bootstrap' }, `Stake: ${config.betting.stakePerEntry} ${config.betting.currencyUnit}`);
    logger.info({ component: 'Bootstrap' }, `Target: ${config.betting.cashOutTarget}x`);
    logger.info({ component: 'Bootstrap' }, `Daily limit: ${config.betting.maxDailyEntries}`);
    if (composition.ctx.halted) {
      logger.warn(
        { component: 'Bootstrap', reason: composition.ctx.haltReason },
        'System started in HALTED state — operator intervention required'
      );
    }

    setupGracefulShutdown(healthMonitor, metricsServer);
  } catch (error) {
    const logger = getLogger();
    logger.fatal(
      { component: 'Bootstrap' },
      `Fatal startup error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

function setupGracefulShutdown(healthMonitor: HealthMonitor, server: import('http').Server): void {
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    const logger = getLogger();
    logger.info({ component: 'Shutdown' }, `Received ${signal}, starting graceful shutdown...`);

    if (stopHeartbeat) {
      try { stopHeartbeat(); } catch { /* ignore */ }
    }
    if (controlPlane) {
      try {
        await controlPlane.stop();
      } catch (err) {
        logger.warn({ component: 'Shutdown', error: String(err) }, 'Control plane stop error');
      }
    }
    if (composition) {
      try {
        await composition.stop();
      } catch (err) {
        logger.warn({ component: 'Shutdown', error: String(err) }, 'Composition stop error');
      }
    }

    server.close(() => {
      logger.info({ component: 'Shutdown' }, 'Metrics server closed');
    });
    healthMonitor.stop();
    await closePool();
    await closeRedisClient();
    logger.info({ component: 'Shutdown' }, 'Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    const logger = getLogger();
    logger.fatal({ component: 'UncaughtException' }, `Uncaught exception: ${err.message}`);
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    const logger = getLogger();
    logger.error({ component: 'UnhandledRejection' }, `Unhandled rejection: ${String(reason)}`);
  });
}

void bootstrap();
