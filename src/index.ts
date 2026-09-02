import dotenv from 'dotenv';
dotenv.config();

import { validateConfig } from './config/validator';
import { createLogger, getLogger } from './observability/logger';
import { createEventBus, getEventBus } from './core/event-bus/bus';
import { createPool, closePool, healthCheck as dbHealthCheck } from './persistence/client';
import { createServer } from 'http';
import { getMetrics, getMetricsContentType } from './observability/metrics/registry';
import { composeApplication, CompositionHandles } from './app/composition';
import { installCrashHandlers } from './utils/crash-handler';

let isShuttingDown = false;
let composition: CompositionHandles | null = null;

async function bootstrap(): Promise<void> {
  try {
    const config = validateConfig();
    createLogger(config.system.serviceName, config.system.logLevel);
    installCrashHandlers();
    const logger = getLogger();
    logger.info({ component: 'Bootstrap' }, 'Starting Personal BC.Game Crash Automation');

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

    composition = composeApplication(config);
    await composition.start();

    const eventBus = getEventBus();
    await eventBus.emitTyped(
      'BrowserStarted',
      { sessionId: 'system', headless: config.browser.headless },
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

    setupGracefulShutdown(metricsServer);
  } catch (error) {
    const logger = getLogger();
    logger.fatal(
      { component: 'Bootstrap' },
      `Fatal startup error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

function setupGracefulShutdown(server: import('http').Server): void {
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    const logger = getLogger();
    logger.info({ component: 'Shutdown' }, `Received ${signal}, starting graceful shutdown...`);

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
    await closePool();
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