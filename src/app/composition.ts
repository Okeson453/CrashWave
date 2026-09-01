/**
 * Slimmed composition root for personal-use CrashWave.
 *
 * This composition implements a minimal, single-operator runtime as specified in
 * the personal-use specification: keeps orchestrator, dry-run, prediction,
 * browser/session supervisor, telegram gateway, persistence repos, and a small
 * worker fleet. Platform / multi-tenant modules are intentionally omitted.
 */

import { hostname } from 'os';
import { AppConfig } from '../config/schema';
import { getLogger } from '../observability/logger';
import { EventBus, getEventBus } from '../core/event-bus/bus';
import { InMemoryPersistentLog } from '../core/event-bus/persistent-log';
import { getPool } from '../persistence/client';
import { BetRepository } from '../persistence/repositories/bet-repo';
import { RoundRepository } from '../persistence/repositories/round-repo';
import { SessionRepository } from '../persistence/repositories/session-repo';
import { TickRepository } from '../persistence/repositories/tick-repo';
import { PredictionRepository } from '../persistence/repositories/prediction-repo';
import { BalanceTracker } from '../ledger/balance-tracker';
import { RecoveryManager } from '../core/recovery-manager';
import { SessionSupervisor } from '../core/session-supervisor';
import { EntryDecisionService } from '../prediction/entry-decision-service';
import { PredictionEngine } from '../prediction/prediction-engine';
import { getRiskEngine } from '../betting/risk-engine';
import { DryRunController } from '../core/dry-run/dry-run-controller';
import { TelegramGateway } from '../telegram/gateway';
import { WorkerFleet } from '../workers/framework/worker-fleet';
import { HealthMonitor } from '../observability/health/monitor';

export interface CompositionContext {
  config: AppConfig;
  eventBus: EventBus;
  betRepo: BetRepository;
  roundRepo: RoundRepository;
  sessionRepo: SessionRepository;
  tickRepo: TickRepository;
  predictionRepo?: PredictionRepository;
  balanceTracker: BalanceTracker;
  recoveryManager: RecoveryManager;
  supervisor: SessionSupervisor;
  entryDecisionService: EntryDecisionService;
  predictionEngine: PredictionEngine;
  riskEngine: ReturnType<typeof getRiskEngine>;
  dryRunController: DryRunController;
  telegram: TelegramGateway | null;
  workerFleet: WorkerFleet;
  halted: boolean;
  haltReason: string | null;
}

export interface CompositionHandles {
  ctx: CompositionContext;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function composeApplication(config: AppConfig, _options?: { healthMonitor?: HealthMonitor }): CompositionHandles {
  const logger = getLogger();
  const eventBus = getEventBus();
  const pool = getPool();

  // Repositories
  const betRepo = new BetRepository(pool);
  const roundRepo = new RoundRepository(pool);
  const sessionRepo = new SessionRepository(pool);
  const tickRepo = new TickRepository(pool);
  let predictionRepo: PredictionRepository | undefined;
  try {
    predictionRepo = new PredictionRepository(pool);
  } catch (e) {
    logger.warn({ component: 'Composition' }, 'Prediction repository unavailable; continuing without persistence');
  }

  // Durable log: prefer Postgres persistent log in other builds; keep in-memory safe fallback
  const durableLog = new InMemoryPersistentLog();

  // Core runtime pieces
  const balanceTracker = new BalanceTracker();
  const recoveryManager = new RecoveryManager(/* unknownRecovery */ undefined as any, /* balanceReconciliation */ undefined as any, betRepo, eventBus);

  const supervisor = new SessionSupervisor({ config, eventBus });

  const predictionEngine = new PredictionEngine();
  const historicalDataService: any = null; // small personal build: historical service optional
  const entryDecisionService = new EntryDecisionService({
    predictionEngine,
    historicalData: historicalDataService,
    riskEngine: getRiskEngine(),
    predictionRepo,
    roundRepo,
  });

  const riskEngine = getRiskEngine();

  const dryRunController = new DryRunController({ /* constructor args are runtime-specific; using existing default wiring */ } as any);

  // Telegram: create gateway only if token provided
  let telegram: TelegramGateway | null = null;
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN_FILE ?? '';
  if (botToken && !String(botToken).includes('REPLACE')) {
    try {
      const tgConfig = {
        botToken: String(botToken),
        allowedUserIds: (config.telegram.allowedUserIds || []).map((id: number) => Number(id)).filter((n: number) => !Number.isNaN(n)),
        verbosity: config.telegram.verbosity,
        webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || undefined,
        rateLimitMessagesPerMinute: config.telegram.rateLimitMessagesPerMinute ?? 30,
        throttlePolicies: [],
        sendRoundStart: config.telegram.sendRoundStart ?? false,
        sendRoundResult: config.telegram.sendRoundResult ?? true,
        sendHealthWarnings: config.telegram.sendHealthWarnings ?? true,
      } as any;
      telegram = new TelegramGateway({ config: tgConfig });
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'Telegram gateway initialization failed');
      telegram = null;
    }
  }

  // Worker fleet (register workers elsewhere as needed)
  const workerFleet = new WorkerFleet();

  const ctx: CompositionContext = {
    config,
    eventBus,
    betRepo,
    roundRepo,
    sessionRepo,
    tickRepo,
    predictionRepo,
    balanceTracker,
    recoveryManager,
    supervisor,
    entryDecisionService,
    predictionEngine,
    riskEngine,
    dryRunController,
    telegram,
    workerFleet,
    halted: false,
    haltReason: null,
  };

  async function start(): Promise<void> {
    logger.info({ component: 'Composition', mode: config.system.mode, host: hostname() }, 'Starting composition root');

    // Start Telegram first so operator can receive early alerts
    if (telegram) {
      try {
        await telegram.start();
        logger.info({ component: 'Composition' }, 'Telegram gateway started');
      } catch (e) {
        logger.warn({ component: 'Composition', error: String(e) }, 'Telegram start failed');
      }
    }

    // Run recovery manager before starting observation
    try {
      const recovery = await recoveryManager.runRecovery();
      logger.info({ component: 'Composition', recovery }, 'Startup recovery finished');
      if (recoveryManager.isHalted && recoveryManager.isHalted()) {
        ctx.halted = true;
        ctx.haltReason = 'Recovery halted the system';
        logger.error({ component: 'Composition', reason: ctx.haltReason }, 'Recovery requested halt');
        return;
      }
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'Startup recovery failed, continuing');
    }

    // Start worker fleet
    try {
      workerFleet.startAll();
      logger.info({ component: 'Composition' }, 'Worker fleet started');
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'Worker fleet start failed');
    }

    // Start session supervisor (browser + orchestrator)
    try {
      await supervisor.start();
      logger.info({ component: 'Composition' }, 'SessionSupervisor started');
    } catch (err) {
      logger.error({ component: 'Composition', error: String(err) }, 'SessionSupervisor failed to start');
      throw err;
    }

    logger.info({ component: 'Composition' }, 'Composition root start complete');
  }

  async function stop(): Promise<void> {
    logger.info({ component: 'Composition' }, 'Stopping composition root');
    try {
      await supervisor.stop();
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'Supervisor stop error');
    }
    try {
      workerFleet.stopAll();
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'Worker fleet stop error');
    }
    if (telegram) {
      try {
        await telegram.stop();
      } catch (err) {
        logger.warn({ component: 'Composition', error: String(err) }, 'Telegram stop error');
      }
    }
    logger.info({ component: 'Composition' }, 'Composition root stopped');
  }

  return { ctx, start, stop };
}
