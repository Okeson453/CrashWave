/**
 * Composition root — wires repositories, recovery, browser, observation,
 * orchestrator, supervisor, Telegram, canary, instance lock, and mode gates.
 */

import { hostname } from 'os';
import { AppConfig } from '../config/schema';
import { getLogger } from '../observability/logger';
import { EventBus, getEventBus } from '../core/event-bus/bus';
import { InMemoryPersistentLog } from '../core/event-bus/persistent-log';
import { PostgresPersistentLog } from '../core/event-bus/postgres-log';
import { OutboxPublisher } from '../core/event-bus/outbox-publisher';
import { getPool } from '../persistence/client';
import { getRedisClient } from '../persistence/redis-client';
import { BetRepository } from '../persistence/repositories/bet-repo';
import { RoundRepository } from '../persistence/repositories/round-repo';
import { SessionRepository } from '../persistence/repositories/session-repo';
import { TickRepository } from '../persistence/repositories/tick-repo';
import { AuditRepository } from '../persistence/repositories/audit-repo';
import { DailyStatsRepository } from '../persistence/repositories/daily-stats-repo';
import { UnknownStateRecovery } from '../ledger/unknown-state-recovery';
import { BalanceReconciliation } from '../ledger/balance-reconciliation';
import { BalanceTracker } from '../ledger/balance-tracker';
import { RecoveryManager } from '../core/recovery-manager';
import { SessionSupervisor } from '../core/session-supervisor';
import { DistributedMutex } from '../core/distributed-mutex';
import { InstanceLock } from '../core/instance-lock';
import { TelegramGateway } from '../telegram/gateway';
import { TelegramBotConfig } from '../telegram/types';
import { NotificationQueue } from '../notifications/queue';
import { TelegramNotifier } from '../notifications/telegram';
import { NotificationRouter } from '../notifications/notification-router';
import { DailyReportScheduler } from '../notifications/daily-report-scheduler';
import { CriticalDispatcher } from '../telegram/dispatchers/critical';
import { HealthDispatcher } from '../telegram/dispatchers/health';
import { RoutineDispatcher } from '../telegram/dispatchers/routine';
import { HealthMonitor } from '../observability/health/monitor';
import { AccountLinkMonitor } from '../browser/account-link-monitor';
import { EntryDecisionService } from '../prediction/entry-decision-service';
import { PredictionEngine } from '../prediction/prediction-engine';
import { HistoricalDataService } from '../prediction/historical-data-service';
import { PredictionRepository } from '../persistence/repositories/prediction-repo';
import { RiskEngine, getRiskEngine } from '../betting/risk-engine';
import { BettingCoordinator } from '../betting/betting-coordinator';
import { RiskStateProvider } from '../betting/risk-state-provider';
import { DailyEntryLedger, DailyEntryCounter } from '../ledger/daily-entries';
import { getDailyKey } from '../utils/day-boundary';
import { generateDailyReport, formatDailyReport } from '../analytics/reports/daily';
import { RoundState } from '../types/game';
import { SettlementReconciler } from '../background-workers/settlement-reconciler';
import { NullEvidenceProvider, RestHistoryEvidenceProvider } from '../settlement/evidence-provider';
import { bootReconcileOpenOrders } from '../settlement/boot-reconcile';

export interface CompositionContext {
  config: AppConfig;
  eventBus: EventBus;
  betRepo: BetRepository;
  roundRepo: RoundRepository;
  sessionRepo: SessionRepository;
  tickRepo: TickRepository;
  auditRepo: AuditRepository;
  dailyStatsRepo: DailyStatsRepository;
  balanceTracker: BalanceTracker;
  recoveryManager: RecoveryManager;
  mutex: DistributedMutex;
  instanceLock: InstanceLock | null;
  supervisor: SessionSupervisor;
  entryDecisionService: EntryDecisionService;
  predictionEngine: PredictionEngine;
  riskEngine: RiskEngine;
  bettingCoordinator: BettingCoordinator | null;
  telegram: TelegramGateway | null;
  notificationQueue: NotificationQueue | null;
  notificationRouter: NotificationRouter | null;
  dailyReportScheduler: DailyReportScheduler | null;
  durableLog: PostgresPersistentLog | InMemoryPersistentLog;
  halted: boolean;
  haltReason: string | null;
}

export interface CompositionHandles {
  ctx: CompositionContext;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build the full application graph. Does not start subsystems until start().
 */
export function composeApplication(
  config: AppConfig,
  _options?: { healthMonitor?: HealthMonitor }
): CompositionHandles {
  const logger = getLogger();
  const eventBus = getEventBus();
  const pool = getPool();

  // Repositories
  const betRepo = new BetRepository(pool);
  const roundRepo = new RoundRepository(pool);
  const sessionRepo = new SessionRepository(pool);
  const tickRepo = new TickRepository(pool);
  const auditRepo = new AuditRepository(pool);
  const dailyStatsRepo = new DailyStatsRepository();

  // Durable event log
  let durableLog: PostgresPersistentLog | InMemoryPersistentLog;
  try {
    const pgLog = new PostgresPersistentLog(pool);
    durableLog = pgLog;
    // Wire into event bus if it supports setPersistentLog
    const busAny = eventBus as unknown as {
      setPersistentLog?: (w: { write: (e: unknown) => Promise<void> }) => void;
      onAny?: (handler: (event: { type: string; id: string; payload: unknown; timestamp: string; correlationId?: string; source?: string }) => void) => void;
    };
    if (typeof busAny.setPersistentLog === 'function') {
      void pgLog.ensureSchema().then(() =>
        busAny.setPersistentLog?.({ write: (e: unknown) => pgLog.write(e as import('../core/event-bus/persistent-log').PersistentLogEntry) })
      );
    } else {
      // Fallback: subscribe to all emitted events if possible
      void pgLog.ensureSchema().catch(() => undefined);
    }
  } catch {
    durableLog = new InMemoryPersistentLog();
    logger.warn({ component: 'Composition' }, 'Using in-memory event log (Postgres unavailable)');
  }

  const outboxPublisher = new OutboxPublisher(pool, eventBus);
  outboxPublisher.start();

  // Balance + recovery
  const balanceTracker = new BalanceTracker();
  const unknownRecovery = new UnknownStateRecovery(betRepo, roundRepo, eventBus);
  const balanceReconciliation = new BalanceReconciliation(betRepo, balanceTracker, eventBus);
  const recoveryManager = new RecoveryManager(
    unknownRecovery,
    balanceReconciliation,
    betRepo,
    eventBus
  );

  // Mutex
  let redis: ReturnType<typeof getRedisClient> | null = null;
  try {
    redis = getRedisClient();
  } catch {
    redis = null;
  }
  const mutex = new DistributedMutex({
    redisClient: redis ?? undefined,
    allowInMemoryFallback: true,
  });

  // Single-active instance (only when Redis available)
  let instanceLock: InstanceLock | null = null;
  if (redis) {
    instanceLock = new InstanceLock({ redis });
  }

  // Session supervisor (owns browser + observation + orchestrator)
  const supervisor = new SessionSupervisor({
    config,
    eventBus,
  });

  // Telegram (optional — requires token) + notification pipeline
  let telegram: TelegramGateway | null = null;
  let notificationQueue: NotificationQueue | null = null;
  let notificationRouter: NotificationRouter | null = null;
  let dailyReportScheduler: DailyReportScheduler | null = null;
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.TELEGRAM_BOT_TOKEN_FILE ||
    '';
  const tokenValue = botToken && !botToken.includes('REPLACE') ? botToken : process.env.TELEGRAM_BOT_TOKEN;

  if (tokenValue && !String(tokenValue).includes('REPLACE_ME')) {
    try {
      const tgConfig: TelegramBotConfig = {
        botToken: String(tokenValue),
        allowedUserIds: (config.telegram.allowedUserIds || []).map((id) => Number(id)).filter((n) => !Number.isNaN(n)),
        verbosity: config.telegram.verbosity,
        webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || undefined,
        rateLimitMessagesPerMinute: config.telegram.rateLimitMessagesPerMinute ?? 30,
        throttlePolicies: [],
        sendRoundStart: config.telegram.sendRoundStart ?? false,
        sendRoundResult: config.telegram.sendRoundResult ?? true,
        sendHealthWarnings: config.telegram.sendHealthWarnings ?? true,
      };
      telegram = new TelegramGateway({ config: tgConfig });
      const operatorIds = (config.telegram.allowedUserIds || [])
        .map((id) => Number(id))
        .filter((n) => !Number.isNaN(n));
      const chatId = String(operatorIds[0] ?? '');
      if (chatId) {
        const notifier = new TelegramNotifier({
          botToken: String(tokenValue),
          operatorChatId: chatId,
          enabled: true,
        });
        notificationQueue = new NotificationQueue({
          maxSize: 200,
          flushIntervalMs: 2000,
          retryAttempts: 5,
          retryDelayMs: 1000,
          deliver: async (message: string) => {
            const r = await notifier.sendMessage(message, { priority: 'normal' });
            return r.sent || r.queued;
          },
        });

        const deliverViaQueueOrDirect = async (
          chatIdNum: number,
          text: string,
          extra?: Record<string, unknown>
        ) => {
          try {
            if (telegram) {
              await telegram.sendMessage(chatIdNum, text, extra);
              return;
            }
            const r = await notifier.sendMessage(text, { priority: 'high' });
            if (!(r.sent || r.queued)) {
              notificationQueue?.enqueue(text, 'critical');
            }
          } catch {
            notificationQueue?.enqueue(text, 'critical');
          }
        };

        const critical = new CriticalDispatcher({
          sendMessage: deliverViaQueueOrDirect,
          operatorChatIds: operatorIds.length ? operatorIds : [Number(chatId)],
          onDeliveryFailure: (_payload, formattedText) => {
            notificationQueue?.enqueue(formattedText, 'critical');
          },
        });
        const health = new HealthDispatcher({
          sendMessage: deliverViaQueueOrDirect,
          operatorChatIds: operatorIds.length ? operatorIds : [Number(chatId)],
        });
        const routine = new RoutineDispatcher({
          sendMessage: deliverViaQueueOrDirect,
          operatorChatIds: operatorIds.length ? operatorIds : [Number(chatId)],
          verbosity: (config.telegram.verbosity as 'quiet' | 'normal' | 'verbose' | 'debug') ?? 'normal',
        });

        notificationRouter = new NotificationRouter({
          eventBus,
          critical,
          health,
          routine,
          queue: notificationQueue,
          config: {
            sendRoundStart: config.telegram.sendRoundStart ?? false,
            sendRoundResult: config.telegram.sendRoundResult ?? true,
            sendHealthWarnings: config.telegram.sendHealthWarnings ?? true,
            verbosity: (config.telegram.verbosity as 'quiet' | 'normal' | 'verbose') ?? 'normal',
          },
        });

        dailyReportScheduler = new DailyReportScheduler({
          queue: notificationQueue,
          reportProvider: async () => {
            try {
              const day = getDailyKey(
                new Date(),
                config.betting?.dayBoundaryTimezone ?? 'UTC'
              );
              await riskStateProvider.refreshDailyEntries();
              const entries = riskStateProvider.getLastConfirmedEntries();
              // Pull real bets for the day when repository supports it
              let outcomes: import('../analytics/types').BetOutcomeRecord[] = [];
              try {
                const bets = await betRepo.findByDailyKey?.(day);
                if (Array.isArray(bets)) {
                  outcomes = bets.map((b: {
                      id: string;
                      roundId?: string | null;
                      stake: number;
                      cashOutTarget?: number | null;
                      state: string;
                      pnl?: number | null;
                      createdAt?: string;
                      settledAt?: string | null;
                    }) => {
                      let outcome: 'win' | 'loss' | 'failed' | 'unknown' = 'unknown';
                      if (b.state === 'WON' || b.state === 'CASHED_OUT') outcome = 'win';
                      else if (b.state === 'LOST') outcome = 'loss';
                      else if (b.state === 'FAILED') outcome = 'failed';
                      return {
                        betId: b.id,
                        roundId: b.roundId ?? 'unknown',
                        dailyKey: day,
                        timestamp: b.settledAt ?? b.createdAt ?? new Date().toISOString(),
                        outcome,
                        pnl: b.pnl ?? 0,
                        stake: b.stake,
                        target: b.cashOutTarget ?? 1.3,
                        cashOutMultiplier: null,
                        latencyMs: null,
                        cashOutSuccess: outcome === 'win' ? true : outcome === 'loss' ? false : null,
                        failureReason: outcome === 'failed' ? b.state : null,
                      };
                    });
                }
              } catch {
                /* bet repo may not have day filter in all envs */
              }
              const report = generateDailyReport({
                dailyKey: day,
                outcomes,
                latencySamples: [],
                balanceStart: null,
                balanceEnd: balanceTracker.getCurrentBalance(),
                currentBalance: balanceTracker.getCurrentBalance() ?? undefined,
                observationConfidence: 'high',
              });
              const text = formatDailyReport(report);
              const pred = entryDecisionService.getLastSignal();
              const predSection = pred
                ? `\n\n*Prediction*\nModel: ${pred.modelVersion}\nP=${(pred.probability * 100).toFixed(1)}% C=${(pred.confidence * 100).toFixed(1)}%\nTarget: ${pred.target}x`
                : '';
              return `${text}${predSection}\n\nDaily entries (ledger): ${entries}/${config.betting?.maxDailyEntries ?? 100}`;
            } catch (err) {
              return `Daily report failed: ${String(err)}`;
            }
          },
        });
      }
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'Telegram init skipped');
    }
  } else {
    logger.warn({ component: 'Composition' }, 'TELEGRAM_BOT_TOKEN not set — gateway disabled');
  }

  // Prediction → Risk bridge (never executes bets; RiskEngine remains final authority)
  const riskEngine = getRiskEngine();
  const predictionEngine = new PredictionEngine();
  const historicalDataService = new HistoricalDataService(roundRepo);
  let predictionRepo: PredictionRepository | undefined;
  try {
    predictionRepo = new PredictionRepository(pool);
  } catch {
    predictionRepo = undefined;
  }
  const entryDecisionService = new EntryDecisionService({
    predictionEngine,
    historicalData: historicalDataService,
    riskEngine,
    predictionRepo,
    roundRepo,
  });

  const dailyCounter = new DailyEntryCounter(config.betting?.dayBoundaryTimezone ?? 'UTC');
  let dailyLedger: DailyEntryLedger | null = null;
  try {
    dailyLedger = new DailyEntryLedger(
      pool,
      config.betting?.maxDailyEntries ?? 100
    );
  } catch {
    dailyLedger = null;
    logger.warn({ component: 'Composition' }, 'DailyEntryLedger unavailable — using in-process counter');
  }

  // Holders avoid temporal dead zone (ctx / coordinator created below)
  const runtimeHolders: {
    getCoordinator: () => import('../betting/betting-coordinator').BettingCoordinator | null;
    isHalted: () => boolean;
  } = {
    getCoordinator: () => null,
    isHalted: () => false,
  };

  const riskStateProvider = new RiskStateProvider({
    config,
    balanceTracker,
    dailyLedger,
    dailyCounter,
    getStateMachine: () => runtimeHolders.getCoordinator()?.getStateMachine() ?? null,
    getLiveState: () => {
      const phase = supervisor.getState().phase;
      const authenticated = supervisor.getState().authenticated;
      const gameLoaded = supervisor.getState().gameLoaded;
      const observing = supervisor.getState().observing;
      const sm = runtimeHolders.getCoordinator()?.getStateMachine();
      const smCtx = sm?.getContext();
      return {
        browserHealthy: phase !== 'error' && phase !== 'stopped',
        gameAdapterHealthy: observing || gameLoaded,
        sessionAuthenticated: authenticated,
        gameLoaded,
        operatorAuthorized: true,
        paused: phase === 'paused' || smCtx?.paused === true,
        killSwitch: runtimeHolders.isHalted() || smCtx?.killSwitch === true,
        openBetExists: smCtx?.openBetExists ?? false,
        cooldownElapsed: true,
        consecutiveErrors: Math.max(
          supervisor.getState().consecutiveErrors,
          smCtx?.consecutiveErrors ?? 0
        ),
        cashOutFailures: smCtx?.cashOutFailures ?? 0,
      };
    },
  });

  const ctx: CompositionContext = {
    config,
    eventBus,
    betRepo,
    roundRepo,
    sessionRepo,
    tickRepo,
    auditRepo,
    dailyStatsRepo,
    balanceTracker,
    recoveryManager,
    mutex,
    instanceLock,
    supervisor,
    entryDecisionService,
    predictionEngine,
    riskEngine,
    bettingCoordinator: null,
    telegram,
    notificationQueue,
    notificationRouter,
    dailyReportScheduler,
    durableLog,
    halted: false,
    haltReason: null,
  };

  async function start(): Promise<void> {
    logger.info(
      { component: 'Composition', mode: config.system.mode, host: hostname() },
      'Starting composition root'
    );

    // 1. Single-active instance for live/dry-run betting modes
    if (instanceLock && (config.system.mode === 'live' || config.system.mode === 'dry-run')) {
      const acquired = await instanceLock.tryAcquire();
      if (!acquired) {
        const msg =
          'Another active instance holds the crash:active-instance lock — refusing to start betting path';
        logger.error({ component: 'Composition' }, msg);
        ctx.halted = true;
        ctx.haltReason = msg;
        // Still allow Telegram + recovery-only / observe if configured
        if (config.system.mode === 'live') {
          throw new Error(msg);
        }
      }
    }

    // Account-link baseline (one profile + sticky proxy + instance)
    const accountLink = new AccountLinkMonitor(eventBus);
    const proxyServer = config.proxy?.enabled ? (config.proxy.server ?? null) : null;
    accountLink.bind({
      profileId: config.browser.profileDirectory,
      proxyServer,
      stickySessionId: config.proxy?.sticky ? `sticky-process-${process.pid}` : null,
      instanceId: instanceLock?.getInstanceId() ?? `local-${hostname()}-${process.pid}`,
      startedAt: new Date().toISOString(),
    });
    (ctx as { accountLink?: AccountLinkMonitor }).accountLink = accountLink;

    // 2. Mandatory recovery before observation/betting
    logger.info({ component: 'Composition' }, 'Running mandatory startup recovery');
    const recovery = await recoveryManager.runRecovery();
    if (recoveryManager.isHalted()) {
      ctx.halted = true;
      ctx.haltReason =
        recovery?.errors?.join('; ') ||
        'Recovery halted system — unresolved UNKNOWN bets or balance imbalance';
      logger.error(
        { component: 'Composition', recovery },
        'Startup recovery failed closed — observation/betting blocked'
      );
      // Start Telegram so operators can investigate
      if (telegram) {
        await telegram.start().catch((e) =>
          logger.warn({ component: 'Composition', error: String(e) }, 'Telegram start failed')
        );
      }
      await eventBus.emitTyped?.(
        'RecoveryFailed' as never,
        { reason: ctx.haltReason },
        'composition',
        'system'
      ).catch(() => undefined);
      return;
    }

    await eventBus.emitTyped?.(
      'RecoveryCompleted' as never,
      { result: recovery },
      'composition',
      'system'
    ).catch(() => undefined);

    // 3. Telegram always (operator control) + notification pipeline
    if (telegram) {
      await telegram.start().catch((e) =>
        logger.warn({ component: 'Composition', error: String(e) }, 'Telegram start failed')
      );
    }
    if (notificationRouter) {
      notificationRouter.start();
      logger.info({ component: 'Composition' }, 'NotificationRouter subscribed to EventBus');
    }
    if (dailyReportScheduler) {
      dailyReportScheduler.start();
    }

    // 4. Mode gates
    if (config.system.mode === 'maintenance') {
      logger.info({ component: 'Composition' }, 'Maintenance mode — no observation/betting');
      return;
    }

    // 4b. Warm rolling history buffer once (live prediction is memory-only thereafter)
    try {
      await entryDecisionService.getHistoricalDataService().ensureWarmed(200);
      logger.info({ component: 'Composition' }, 'Rolling history buffer warmed');
    } catch (err) {
      logger.warn(
        { component: 'Composition', error: String(err) },
        'History buffer warm failed — will retry on first entry'
      );
    }

    // 5. Session supervisor (browser + observe / orchestrate)
    if (!ctx.halted) {
      // Boot-time reconcile of open settlement_orders (before accepting new bets)
      try {
        const su = (config as any).specUpgrade?.settlement ?? {};
        if (su.enabled !== false) {
          const provider =
            su.evidenceProvider === 'rest_history' && su.evidenceBaseUrl
              ? new RestHistoryEvidenceProvider({
                  baseUrl: su.evidenceBaseUrl,
                  headers: process.env.SETTLEMENT_EVIDENCE_HEADERS
                    ? JSON.parse(process.env.SETTLEMENT_EVIDENCE_HEADERS)
                    : undefined,
                })
              : new NullEvidenceProvider();
          const bootResult = await bootReconcileOpenOrders(getPool(), provider, {
            voidIfOlderMs: 15 * 60 * 1000,
          });
          logger.info({ component: 'Composition', ...bootResult }, 'Boot settlement reconcile finished');
        }
      } catch (e) {
        logger.warn({ component: 'Composition', error: String(e) }, 'Boot settlement reconcile skipped');
      }

      await supervisor.start();

      // 5b. Wire live Prediction → Risk → StateMachine → Executor path
      const liveWiring = supervisor.getLiveWiring();
      const bettingCoordinator = new BettingCoordinator({
        config,
        entryDecisionService,
        liveBetExecutor: liveWiring?.liveBetExecutor ?? null,
        sessionId: supervisor.getState()?.sessionId ?? null,
        buildRiskInput: () => riskStateProvider.buildFresh(),
        onEntryConfirmed: () => {
          dailyCounter.increment();
          void riskStateProvider.refreshDailyEntries();
        },
        dailyLedger,
      });
      ctx.bettingCoordinator = bettingCoordinator;
      runtimeHolders.getCoordinator = () => bettingCoordinator;
      runtimeHolders.isHalted = () => ctx.halted;
      if (liveWiring) {
        liveWiring.bettingCoordinator = bettingCoordinator;
      }

      // Subscribe to round lifecycle on the event bus
      const busAny = eventBus as unknown as {
        onTyped?: (type: string, handler: (payload: Record<string, unknown>) => void) => void;
        on?: (type: string, handler: (...args: unknown[]) => void) => void;
      };
      const onRoundStarted = (...args: unknown[]) => {
        const payload = (args[0] ?? {}) as Record<string, unknown>;
        const roundId = String(payload.roundId ?? '');
        if (!roundId) return;
        const roundState: RoundState = {
          roundId,
          phase: 'starting',
          currentMultiplier: 1,
          startedAt: String(payload.startedAt ?? new Date().toISOString()),
          crashedAt: null,
          crashPoint: null,
          lastTickAt: null,
          source: 'websocket',
          confidence: 'high',
        };
        void bettingCoordinator.onRoundStarted(roundId, roundState);
      };
      const onRoundCrashed = (...args: unknown[]) => {
        const payload = (args[0] ?? {}) as Record<string, unknown>;
        const roundId = String(payload.roundId ?? '');
        const crashPoint = Number(payload.crashPoint ?? payload.multiplier ?? 0);
        if (!roundId || !Number.isFinite(crashPoint)) return;
        void bettingCoordinator.onRoundCrashed(roundId, crashPoint);
      };
      if (typeof busAny.onTyped === 'function') {
        busAny.onTyped('RoundStarted', onRoundStarted);
        busAny.onTyped('RoundCrashed', onRoundCrashed);
      } else if (typeof busAny.on === 'function') {
        busAny.on('RoundStarted', onRoundStarted);
        busAny.on('RoundCrashed', onRoundCrashed);
      }

      logger.info(
        { component: 'Composition', hasExecutor: !!liveWiring?.liveBetExecutor },
        'BettingCoordinator wired to RoundStarted/RoundCrashed'
      );

      logger.info(
        { component: 'Composition', phase: supervisor.getState?.()?.phase },
        'SessionSupervisor started'
      );
    }

    // Settlement VOID-after-deadline reconciler
    let settlementReconciler: SettlementReconciler | null = null;
    try {
      const su = (config as any).specUpgrade?.settlement ?? {};
      if (su.enabled !== false) {
        const provider =
          su.evidenceProvider === 'rest_history' && su.evidenceBaseUrl
            ? new RestHistoryEvidenceProvider({
                baseUrl: su.evidenceBaseUrl,
                headers: process.env.SETTLEMENT_EVIDENCE_HEADERS
                  ? JSON.parse(process.env.SETTLEMENT_EVIDENCE_HEADERS)
                  : undefined,
              })
            : new NullEvidenceProvider();
        settlementReconciler = new SettlementReconciler(getPool(), provider, {
          enabled: true,
          reconcileDeadlineMs: 15 * 60 * 1000,
        });
        settlementReconciler.start();
        (ctx as any).settlementReconciler = settlementReconciler;
      }
    } catch (e) {
      logger.warn({ component: 'Composition', error: String(e) }, 'Settlement reconciler not started');
    }

    logger.info({ component: 'Composition' }, 'Composition root start complete');
  }

  async function stop(): Promise<void> {
    notificationRouter?.stop();
    dailyReportScheduler?.stop();

    logger.info({ component: 'Composition' }, 'Stopping composition root');
    try {
      outboxPublisher.stop();
    await supervisor.stop();
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'Supervisor stop error');
    }
    if (telegram) {
      try {
        await telegram.stop?.();
      } catch {
        /* ignore */
      }
    }
    // NotificationQueue has no stop in current implementation
    if (instanceLock) {
      await instanceLock.release();
    }
    logger.info({ component: 'Composition' }, 'Composition root stopped');
  }

  return { ctx, start, stop };
}
