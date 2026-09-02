/**
 * Personal-use composition root.
 *
 * Single-process Node.js runtime:
 *   - logger + DB pool
 *   - event bus
 *   - core repos (sessions, rounds, ticks, bets, predictions)
 *   - dry-run controller + virtual ledger
 *   - decision engine + opportunity ranker
 *   - prediction engine + entry-decision service
 *   - risk engine + state provider
 *   - sheath mode + recovery manager
 *   - 6-worker fleet (analytics, learning, settlement, risk, validation, regime)
 *   - telegram gateway (with all router dependencies injected)
 *
 * No tenant manager. No billing. No admin. No public API. No multi-process locks.
 */
import type { AppConfig } from '../config/schema';
import { getLogger } from '../observability/logger';
import { EventBus, getEventBus } from '../core/event-bus/bus';
import { getPool, getPoolStats } from '../persistence/client';
import { BetRepository } from '../persistence/repositories/bet-repo';
import { RoundRepository } from '../persistence/repositories/round-repo';
import { SessionRepository } from '../persistence/repositories/session-repo';
import { TickRepository } from '../persistence/repositories/tick-repo';
import { PredictionRepository } from '../persistence/repositories/prediction-repo';
import { TelegramGateway } from '../telegram/gateway';
import { TelegramBotConfig } from '../telegram/types';
import { DEFAULT_THROTTLE_POLICIES } from '../telegram/types';
import { PredictionEngine } from '../prediction/prediction-engine';
import { EntryDecisionService } from '../prediction/entry-decision-service';
import { prewarmPredictionStack } from '../prediction/prewarm';
import { setPrewarmResult, getReadiness } from '../observability/readiness';
import { DecisionEngine } from '../decision/decision-engine';
import { OpportunityRanker } from '../opportunity/ranker';
import { RiskEngine } from '../betting/risk-engine';
import { SheathMode } from '../core/sheath-mode';
import { DryRunController } from '../core/dry-run/dry-run-controller';
import { VirtualTradeLedger } from '../core/dry-run/virtual-ledger';
import { WorkerFleet } from '../workers/framework/worker-fleet';
import { RegimeWorker } from '../workers/regime/regime-worker';
import { RiskWorker } from '../workers/risk/risk-worker';
import { SettlementWorker } from '../workers/settlement/settlement-worker';
import { LearningWorker } from '../workers/learning/learning-worker';
import { ValidationWorker } from '../workers/validation/validation-worker';
import { AnalyticsWorker } from '../workers/analytics/analytics-worker';
import { randomUUID } from 'crypto';
import { LiveAlerts } from '../observability/alerts/live-alerts';
import { RecoveryManager } from '../core/recovery-manager';
import { UnknownStateRecovery } from '../ledger/unknown-state-recovery';
import { BalanceReconciliation } from '../ledger/balance-reconciliation';
import { BalanceTracker } from '../ledger/balance-tracker';
import { SessionSupervisor } from '../core/session-supervisor';
import { LiveBetExecutor } from '../betting/live-executor';
import { LiveCashOutExecutor } from '../betting/live-cashout';
import { resolvePlacementPath } from '../betting/bet-executor-factory';


const logger = getLogger();

export interface CompositionContext {
  config: AppConfig;
  eventBus: EventBus;
  sessionRepo: SessionRepository;
  roundRepo: RoundRepository;
  tickRepo: TickRepository;
  betRepo: BetRepository;
  predictionRepo: PredictionRepository;
  dryRunController: DryRunController;
  virtualLedger: VirtualTradeLedger;
  decisionEngine: DecisionEngine;
  opportunityRanker: OpportunityRanker;
  predictionEngine: PredictionEngine;
  entryDecisionService: EntryDecisionService;
  riskEngine: RiskEngine;
  sheathMode: SheathMode;
  recoveryManager: RecoveryManager;
  liveAlerts: LiveAlerts;
  workerFleet: WorkerFleet;
  telegramGateway: TelegramGateway | null;
  telegramEnabled: boolean;
  halted: boolean;
  haltReason?: string;
  /** Read-only runtime view (sessionId, mode, recentTrades, lastRound). */
  runtime: {
    sessionId: string;
    currentMode: AppConfig['system']['mode'];
    recentTrades: Array<Record<string, unknown>>;
    lastRound?: Record<string, unknown>;
    halted: boolean;
    haltReason?: string;
    startedAt: number;
  };
}

export interface CompositionHandles {
  ctx: CompositionContext;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function composeApplication(config: AppConfig): CompositionHandles {
  const eventBus = getEventBus();
  const pool = getPool();

  // Repositories
  const sessionRepo = new SessionRepository(pool);
  const roundRepo = new RoundRepository(pool);
  const tickRepo = new TickRepository(pool);
  const betRepo = new BetRepository(pool);
  const predictionRepo = new PredictionRepository(pool);

  // Core building blocks
  const virtualLedger = new VirtualTradeLedger(config.dryRun.initialVirtualBalance);
  const dryRunController = new DryRunController({
    stake: config.dryRun.stake,
    target: config.dryRun.target,
    minProbability: config.dryRun.minProbability,
    minConfidence: config.dryRun.minConfidence,
  });
  const riskEngine = new RiskEngine();
  const opportunityRanker = new OpportunityRanker();
  const decisionEngine = new DecisionEngine();
  const predictionEngine = new PredictionEngine();
  const entryDecisionService = new EntryDecisionService({
    predictionEngine,
    riskEngine,
    predictionRepo,
    roundRepo,
    decisionRanker: opportunityRanker as never,
  });
  const sheathMode = new SheathMode();
  // Personal-use recovery manager (spec §2.1, §7.2). The advanced Crash
  // implementation handles three things on boot:
  //   1. resolve UNKNOWN bets via the round-history heuristic
  //   2. reconcile virtual/real balance against the DB ledger
  //   3. resume from any prior halted state
  // In personal-use dry-run there are no live bets and no DB balance, so
  // runRecovery() returns an empty result. The wiring is preserved so
  // that live-mode (when /login + /mode live) gets the full pipeline.
  const unknownStateRecovery = new UnknownStateRecovery(betRepo, roundRepo, eventBus);
  const balanceTracker = new BalanceTracker();
  const balanceReconciliation = new BalanceReconciliation(betRepo, balanceTracker, eventBus);
  const recoveryManager = new RecoveryManager(
    unknownStateRecovery,
    balanceReconciliation,
    betRepo,
    eventBus
  );

  // Live alerts: emits health/risk/recovery events onto the bus and can
  // forward to Telegram. Kept from the advanced Crash build (spec §2.8).
  const liveAlerts = new LiveAlerts(eventBus, { emitToEventBus: true });

  // Mutable runtime state tracked by the orchestrator stubs.
  const runtime = {
    sessionId: randomUUID(),
    startedAt: Date.now(),
    lastRound: null as Record<string, unknown> | null,
    recentTrades: [] as Array<Record<string, unknown>>,
    halted: false,
    haltReason: undefined as string | undefined,
    currentMode: config.system.mode,
  };

  // Wrap the dry-run controller's `onRoundCompleted` to mirror virtual
  // trades into runtime.recentTrades so /status / /entries can show them.
  // (The controller itself does not emit a typed event in the personal-use
  // build; we instrument the ledger by monkey-patching the controller.)
  type EvaluateAndSimulate = typeof dryRunController.evaluateAndSimulate;
  type OnRoundCompleted = typeof dryRunController.onRoundCompleted;
  const originalEvaluate = dryRunController.evaluateAndSimulate.bind(dryRunController);
  (dryRunController as { evaluateAndSimulate: EvaluateAndSimulate }).evaluateAndSimulate =
    ((signal: Parameters<EvaluateAndSimulate>[0]) => {
      const result = originalEvaluate(signal);
      const sig = signal as { signalId?: string; predictionId?: string; roundId?: string; stake?: number; target?: number };
      if (result && typeof result === 'object' && (result as { accepted?: boolean }).accepted) {
        const trade = {
          virtualTradeId: `vt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          signalId: sig.signalId,
          predictionId: sig.predictionId,
          roundId: sig.roundId,
          stake: sig.stake ?? config.dryRun.stake,
          target: sig.target ?? config.dryRun.target,
          status: 'OPEN',
          openedAt: new Date().toISOString(),
        };
        runtime.recentTrades.unshift(trade);
        if (runtime.recentTrades.length > 50) runtime.recentTrades.length = 50;
      }
      return result;
    }) as EvaluateAndSimulate;
  const originalResolve = dryRunController.onRoundCompleted.bind(dryRunController);
  (dryRunController as { onRoundCompleted: OnRoundCompleted }).onRoundCompleted =
    ((roundId: string, crashPoint: number) => {
      originalResolve(roundId, crashPoint);
      for (const t of runtime.recentTrades) {
        if (t.roundId === roundId && t.status === 'OPEN') {
          const win = Number(crashPoint) >= Number(t.target);
          t.status = win ? 'WIN' : 'LOSS';
          t.crashPoint = crashPoint;
          const stake = Number(t.stake ?? 0);
          t.pnl = win ? stake * (Number(t.target) - 1) : -stake;
          t.resolvedAt = new Date().toISOString();
        }
      }
    }) as OnRoundCompleted;

  // Worker fleet (6 workers, single-process)
  const workerFleet = new WorkerFleet();
  workerFleet.register(new AnalyticsWorker());
  workerFleet.register(new LearningWorker());
  workerFleet.register(new SettlementWorker());
  workerFleet.register(new RiskWorker({
    riskEngine,
    buildRiskInput: (payload) => {
      const supState = sessionSupervisor.getState();
      const balance = virtualLedger.getBalance();
      const openBetExists = liveBetExecutor?.isBusy() ?? false;
      let dailyEntriesConfirmed = 0;
      try {
        dailyEntriesConfirmed = runtime.recentTrades.filter((t) => {
          const openedAt = String(t.openedAt ?? '');
          const today = new Date().toISOString().slice(0, 10);
          return openedAt.startsWith(today);
        }).length;
      } catch { dailyEntriesConfirmed = 0; }
      return {
        mode: config.system.mode as 'observe-only' | 'dry-run' | 'live' | 'maintenance',
        operatorAuthorized: true,
        sessionAuthenticated: supState.authenticated,
        gameLoaded: supState.gameLoaded,
        roundState: payload?.roundId
          ? {
              phase: 'starting' as const,
              roundId: String(payload.roundId),
              currentMultiplier: 1,
              crashPoint: null,
              startedAt: new Date().toISOString(),
              lastTickAt: null,
              crashedAt: null,
              confidence: 'medium' as const,
              source: 'dom' as const,
            }
          : null,
        currentBalance: balance,
        dailyEntriesConfirmed,
        paused: runtime.halted,
        killSwitch: false,
        browserHealthy: supState.phase !== 'browser-failed' && supState.phase !== 'error',
        gameAdapterHealthy: supState.gameLoaded,
        openBetExists,
        cooldownElapsed: true,
        requiredStake: config.betting.stakePerEntry,
        balanceBuffer: config.risk.balanceBuffer,
        maxDailyEntries: config.betting.maxDailyEntries,
        minConfidenceForEntry: 'medium' as const,
        consecutiveErrors: supState.consecutiveErrors ?? 0,
        maxConsecutiveErrors: config.risk.maxConsecutiveErrorsBeforeStop,
        cashOutFailures: 0,
        maxCashOutFailures: config.risk.maxCashOutFailuresBeforeStop,
        minPredictionProbability: config.risk.minPredictionProbability,
        minPredictionConfidence: config.risk.minPredictionConfidence,
      };
    },
  }));
  workerFleet.register(new ValidationWorker());
  workerFleet.register(new RegimeWorker());

  // SessionSupervisor owns persistent browser + BC.Game auth + observation.
  // /login keeps the browser alive, persists encrypted session state, navigates
  // to Crash, and starts GameAdapter/RoundObserver so RoundStarted/RoundCrashed
  // flow to the EventBus (and dry-run bridge).
  const sessionSupervisor = new SessionSupervisor({
    config,
    eventBus,
    dryRunController,
    sessionId: runtime.sessionId,
  });

  // Live placement path (page bound after supervisor has a browser page)
  const liveBetExecutor = new LiveBetExecutor(null, betRepo);
  const liveCashOutExecutor = new LiveCashOutExecutor(null);

  // Telegram gateway
  const telegramEnabled = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  let telegramGateway: TelegramGateway | null = null;

  if (telegramEnabled) {
    const allowedUserIds: number[] = Array.isArray(config.telegram.allowedUserIds)
      ? (config.telegram.allowedUserIds as number[])
      : [];
    const botConfig: TelegramBotConfig = {
      botToken: process.env.TELEGRAM_BOT_TOKEN as string,
      allowedUserIds,
      verbosity: config.telegram.verbosity,
      polling: true,
      rateLimitMessagesPerMinute: config.telegram.rateLimitMessagesPerMinute,
      throttlePolicies: DEFAULT_THROTTLE_POLICIES,
      sendRoundStart: config.telegram.sendRoundStart,
      sendRoundResult: config.telegram.sendRoundResult,
      sendHealthWarnings: config.telegram.sendHealthWarnings,
    };
    telegramGateway = new TelegramGateway({ config: botConfig });

    // Inject router dependencies. These are read by the command handlers
    // (status, login, analytics, control, config).
    telegramGateway.setRouterDependencies({
      getOrchestratorState: () => {
        const sup = sessionSupervisor.getState();
        return {
          sessionId: runtime.sessionId,
          uptimeSeconds: (Date.now() - runtime.startedAt) / 1000,
          mode: runtime.currentMode,
          lastRound: runtime.lastRound,
          recentTrades: runtime.recentTrades,
          halted: runtime.halted,
          haltReason: runtime.haltReason,
          phase: sup.phase,
          authenticated: sup.authenticated,
          observing: sup.observing,
          gameLoaded: sup.gameLoaded,
          browserLaunched: sup.browserLaunched,
          loginStatus: sup.loginStatus,
        };
      },
      getLedgerSummary: () => virtualLedger.snapshot() as unknown as Record<string, unknown>,
      getHealthStatus: () => {
        const sup = sessionSupervisor.getState();
        const degraded = sup.phase === 'error' || sup.phase === 'browser-failed' || sup.phase === 'region-blocked';
        let database: { total: number; idle: number; waiting: number } | { error: string };
        try {
          const stats = getPoolStats();
          database = { total: stats.total, idle: stats.idle, waiting: stats.waiting };
        } catch (err) {
          database = { error: err instanceof Error ? err.message : String(err) };
        }
        return {
          status: degraded ? 'degraded' : 'healthy',
          mode: runtime.currentMode,
          session: runtime.sessionId,
          database,
          prediction: getReadiness(),
          lastRound: runtime.lastRound,
          workers: workerFleet.snapshot(),
          browser: {
            phase: sup.phase,
            launched: sup.browserLaunched,
            authenticated: sup.authenticated,
            observing: sup.observing,
            gameLoaded: sup.gameLoaded,
            loginStatus: sup.loginStatus,
          },
        };
      },
      getWindowedAnalytics: (_amount: number, _unit: string) => {
        const trades = runtime.recentTrades;
        const resolved = trades.filter((t) => t.status !== 'OPEN');
        const avgProb = resolved.length > 0
          ? resolved.reduce((s, t) => s + Number(t.probability ?? 0), 0) / resolved.length
          : 0;
        const avgConf = resolved.length > 0
          ? resolved.reduce((s, t) => s + Number(t.confidence ?? 0), 0) / resolved.length
          : 0;
        const totalStake = resolved.reduce((s, t) => s + Number(t.stake ?? 0), 0);
        const totalPnl = resolved.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
        const ev = totalStake > 0 ? totalPnl / totalStake : 0;
        return {
          signals: trades.length,
          signalsAccepted: resolved.length,
          signalsRejected: 0,
          avgProbability: avgProb,
          avgConfidence: avgConf,
          expectedValue: ev,
          regime: 'normal',
          modelVersion: 'v1',
        };
      },
      setSystemMode: async (mode: string) => {
        const valid = ['observe-only', 'dry-run', 'live', 'maintenance'];
        if (!valid.includes(mode)) return false;
        const previousMode = runtime.currentMode;
        runtime.currentMode = mode as AppConfig['system']['mode'];
        (config.system as unknown as { mode: string }).mode = mode as AppConfig['system']['mode'];
        if (mode === 'live') {
          runtime.halted = false;
          runtime.haltReason = undefined;
        }
        logger.warn({ previousMode, newMode: mode }, 'Mode changed; restart required for full effect');
        return true;
      },
      pauseSystem: async (reason: string) => {
        runtime.halted = true;
        runtime.haltReason = reason;
        try { await dryRunController.stop(); } catch { /* ignore */ }
        try { await sessionSupervisor.stop(); } catch { /* ignore */ }
        return true;
      },
      resumeSystem: async () => {
        runtime.halted = false;
        runtime.haltReason = undefined;
        try { await sessionSupervisor.start(); } catch { /* ignore */ }
        try { dryRunController.start(runtime.sessionId); } catch { /* ignore */ }
        return true;
      },
      stopSystem: async () => {
        runtime.halted = true;
        runtime.haltReason = 'stopped';
        try { await dryRunController.stop(); } catch { /* ignore */ }
        try { await sessionSupervisor.stop(); } catch { /* ignore */ }
        if (telegramGateway) {
          try { await telegramGateway.stop(); } catch { /* ignore */ }
        }
        return true;
      },
      getConfigValue: (key: string) => {
        const parts = key.split('.');
        let v: unknown = config;
        for (const p of parts) {
          if (v && typeof v === 'object') v = (v as Record<string, unknown>)[p];
          else return undefined;
        }
        return v;
      },
      setConfigValue: async (key: string, value: string) => {
        const parts = key.split('.');
        let target: Record<string, unknown> = config as unknown as Record<string, unknown>;
        for (let i = 0; i < parts.length - 1; i++) {
          const p = parts[i];
          if (!target[p] || typeof target[p] !== 'object') return false;
          target = target[p] as Record<string, unknown>;
        }
        const last = parts[parts.length - 1];
        const num = Number(value);
        if (last === 'stakePerEntry' || last === 'cashOutTarget' || last === 'maxDailyEntries') {
          if (!Number.isFinite(num) || num <= 0) return false;
          (target as Record<string, unknown>)[last] = num;
        } else if (last === 'mode') {
          const valid = ['observe-only', 'dry-run', 'live', 'maintenance'];
          if (!valid.includes(value)) return false;
          (target as Record<string, unknown>)[last] = value;
        } else {
          (target as Record<string, unknown>)[last] = value;
        }
        return true;
      },
      sheathSystem: async () => true,
      unsheathSystem: async () => true,
      getSheathState: () => ({ state: 'armed', bettingSuspended: false, triggers: [] }),
      loginWithCredentials: async (email: string, password: string) => {
        // SessionSupervisor: preflight → launch/reuse browser → login pipeline →
        // encrypt session → navigate to Crash → start observation. Browser stays
        // alive. Password is scoped to the call and never logged/persisted.
        let outcome: Awaited<ReturnType<typeof sessionSupervisor.loginWithCredentials>> | undefined;
        try {
          outcome = await sessionSupervisor.loginWithCredentials(email, password);
          logger.info(
            {
              component: 'Composition',
              maskedEmail: outcome.maskedEmail,
              ok: outcome.ok,
              authenticated: outcome.authenticated,
              pageState: outcome.pageState,
              regionBlocked: outcome.regionBlocked,
              observing: outcome.observing,
              gameLoaded: outcome.gameLoaded,
              phase: sessionSupervisor.getPhase(),
            },
            '/login handler returned'
          );
          return outcome;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(
            { component: 'Composition', error: message },
            '/login handler threw'
          );
          return {
            ...(outcome ?? {}),
            ok: false,
            authenticated: false,
            detail: `LOGIN_HANDLER_ERROR: ${message}`.slice(0, 600),
            maskedEmail: email.length > 0 ? `${email[0]}***@${email.split('@')[1] ?? '?'}` : '***',
          };
        }
      },
    });
  }

  const ctx: CompositionContext = {
    config,
    eventBus,
    sessionRepo,
    roundRepo,
    tickRepo,
    betRepo,
    predictionRepo,
    dryRunController,
    virtualLedger,
    decisionEngine,
    opportunityRanker,
    predictionEngine,
    entryDecisionService,
    riskEngine,
    sheathMode,
    recoveryManager,
    liveAlerts,
    workerFleet,
    telegramGateway,
    telegramEnabled,
    halted: false,
    runtime: {
      sessionId: runtime.sessionId,
      currentMode: runtime.currentMode,
      recentTrades: runtime.recentTrades,
      lastRound: runtime.lastRound ?? undefined,
      halted: runtime.halted,
      haltReason: runtime.haltReason,
      startedAt: runtime.startedAt,
    },
  };

  let started = false;
  let dailyReportTimer: NodeJS.Timeout | null = null;
  const DAILY_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    logger.info({ component: 'Composition' }, 'Starting personal-use composition');
    // Start the dry-run controller (no-op if no event bus subscriptions exist).
    try {
      dryRunController.start(runtime.sessionId);
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'DryRunController start skipped');
    }
    // Run startup reconciliation (spec §7.2). In dry-run this is a no-op
    // (no UNKNOWN bets, no real balance to reconcile); in live mode it
    // recovers any stuck bets from the previous session.
    try {
      const result = await recoveryManager.runRecovery();
      logger.info(
        {
          component: 'Composition',
          phase: result.phase,
          betRecovered: result.betRecovery?.resolved ?? 0,
          balanceOk: result.balanceReconciliation?.withinTolerance ?? true,
        },
        'RecoveryManager.runRecovery completed'
      );
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'RecoveryManager.runRecovery failed (continuing)');
    }
    // Wire the dry-run signal bridge (spec §1.2, §7.1): subscribes the
    // orchestrator's RoundStarted/RoundCrashed events and routes them
    // through EntryDecisionService into the dry-run controller.
    try {
      const bridge = await import('../core/dry-run/dry-run-bridge.js');
      const bridgeDeps = {
        config,
        dryRunController,
        riskStateProvider: {
          buildFresh: async () => ({
            sessionAuthenticated: sessionSupervisor.isAuthenticated() || config.system.mode === 'dry-run',
            currentBalance: virtualLedger.getBalance(),
            consecutiveErrors: 0,
            consecutiveCashOutFailures: 0,
          }),
        } as never,
        entryDecisionService,
        sessionId: runtime.sessionId,
      };
      // Subscribe to the orchestrator events via the shared event bus.
      eventBus.on('RoundStarted', (ev: { payload?: { roundId?: string } }) => {
        const roundId = String(ev?.payload?.roundId ?? '');
        if (roundId) {
          void bridge.onRoundStartedForDryRun(bridgeDeps, roundId);
        }
      });
      eventBus.on('RoundCrashed', (ev: { payload?: { roundId?: string; crashPoint?: number } }) => {
        const p = ev?.payload;
        if (p?.roundId) {
          bridge.onRoundCrashedForDryRun(bridgeDeps, p);
        }
      });
      logger.info({ component: 'Composition' }, 'DryRunBridge wired to RoundStarted/RoundCrashed');
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'DryRunBridge wire skipped');
    }

    // Live bridge — isolated from dry-run; requires mode=live + ALLOW_REAL_EXECUTION
    try {
      const liveBridge = await import('../core/live-bridge.js');
      const liveDeps = {
        config,
        entryDecisionService,
        liveBetExecutor,
        liveCashOutExecutor,
        sessionId: runtime.sessionId,
        isAuthenticated: () => sessionSupervisor.isAuthenticated(),
        isGameLoaded: () => sessionSupervisor.getState().gameLoaded,
        isObserving: () => sessionSupervisor.isObserving(),
        getBalance: () => {
          try {
            return Number((virtualLedger as { getBalance?: () => number }).getBalance?.() ?? 0);
          } catch {
            return 0;
          }
        },
      };
      eventBus.on('RoundStarted', (ev: { payload?: { roundId?: string } }) => {
        const roundId = String(ev?.payload?.roundId ?? '');
        if (!roundId) return;
        // Bind page each round in case browser recovered
        try {
          const page = sessionSupervisor.getBrowserManager()?.getPage() ?? null;
          liveBetExecutor.bindPage(page);
          liveCashOutExecutor.bindPage(page);
        } catch { /* ignore */ }
        void liveBridge.onRoundStartedForLive(liveDeps, roundId);
      });
      eventBus.on('RoundCrashed', (ev: { payload?: { roundId?: string; crashPoint?: number } }) => {
        const p = ev?.payload;
        if (p?.roundId) void liveBridge.onRoundCrashedForLive(liveDeps, p);
      });
      const path = resolvePlacementPath({
        mode: config.system.mode as 'live' | 'dry-run' | 'observe-only' | 'maintenance',
        liveBound: true,
      });
      logger.info({ component: 'Composition', placementPath: path.path }, 'LiveBridge wired');
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'LiveBridge wire skipped');
    }

    // Persist rounds when observation emits (best-effort)
    try {
      eventBus.on('RoundStarted', (ev: { payload?: { roundId?: string; sessionId?: string; startedAt?: string } }) => {
        const p = ev?.payload;
        if (!p?.roundId) return;
        void roundRepo
          .create({
            externalRoundId: p.roundId,
            sessionId: p.sessionId ?? runtime.sessionId,
            startedAt: p.startedAt ?? new Date().toISOString(),
            observationSource: 'session-supervisor',
            dataQuality: 'medium',
          })
          .catch((e: unknown) =>
            logger.debug({ component: 'Composition', error: String(e) }, 'round create skipped')
          );
      });
      eventBus.on('RoundCrashed', (ev: { payload?: { roundId?: string; crashPoint?: number; crashedAt?: string } }) => {
        const p = ev?.payload;
        if (!p?.roundId || p.crashPoint == null) return;
        void (async () => {
          try {
            const existing = await roundRepo.findByExternalId?.(p.roundId!);
            if (existing?.id) {
              await roundRepo.update(existing.id, {
                crashedAt: p.crashedAt ?? new Date().toISOString(),
                observedCrashPoint: p.crashPoint,
                finalConfirmedCrashPoint: p.crashPoint,
              });
            }
          } catch (e) {
            logger.debug({ component: 'Composition', error: String(e) }, 'round update skipped');
          }
        })();
      });
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'Round persistence wire skipped');
    }

    // Start SessionSupervisor: launches browser, restores encrypted session if
    // present, navigates to Crash (dry-run/observe-only), starts observation.
    // Live mode without a restored session stays in auth-required until /login.
    try {
      await sessionSupervisor.start();
      logger.info(
        {
          component: 'Composition',
          phase: sessionSupervisor.getPhase(),
          authenticated: sessionSupervisor.isAuthenticated(),
          observing: sessionSupervisor.isObserving(),
        },
        'SessionSupervisor started'
      );
    } catch (err) {
      logger.warn(
        { component: 'Composition', error: String(err) },
        'SessionSupervisor.start failed (Telegram /login still available)'
      );
    }

    // F012: pre-warm prediction stack from DB history (fail-soft if empty DB)
    try {
      const warm = await prewarmPredictionStack(entryDecisionService, 500);
      setPrewarmResult({
        stateWarm: warm.stateWarm ?? true,
        calibrationWarm: warm.calibrationWarm ?? true,
        historyRounds: warm.historyRounds,
        acieHistorySize: warm.acieHistorySize,
      });
      logger.info(
        {
          component: 'Composition',
          historyRounds: warm.historyRounds,
          acieHistorySize: warm.acieHistorySize,
          stateWarm: warm.stateWarm,
          calibrationWarm: warm.calibrationWarm,
          durationMs: warm.durationMs,
        },
        'Prediction stack prewarm completed'
      );
    } catch (err) {
      setPrewarmResult(null, err instanceof Error ? err.message : String(err));
      logger.warn(
        { component: 'Composition', error: String(err) },
        'Prediction prewarm failed (live entries remain fail-closed until warm)'
      );
    }

    await workerFleet.startAll();

    // F011: feed background workers + rolling history from live crash points
    try {
      const mkCtx = (roundId: string) => ({
        tenantId: null as string | null,
        correlationId: roundId,
        eventId: `evt-${roundId}-${Date.now()}`,
        receivedAt: new Date().toISOString(),
      });
      eventBus.on('RoundCrashed', (ev: { payload?: { roundId?: string; crashPoint?: number; crashedAt?: string } }) => {
        const p = ev?.payload;
        if (!p?.roundId || p.crashPoint == null || !Number.isFinite(Number(p.crashPoint))) return;
        const crashPoint = Number(p.crashPoint);
        const roundId = String(p.roundId);
        const ctx = mkCtx(roundId);
        const payload = { type: 'crash', roundId, crashPoint, multiplier: crashPoint, at: p.crashedAt };

        const hist = entryDecisionService.getHistoricalDataService();
        hist.onRoundCompleted({
          id: roundId,
          externalRoundId: roundId,
          sessionId: runtime.sessionId,
          startedAt: null,
          crashedAt: p.crashedAt ?? new Date().toISOString(),
          crashPoint,
          observationSource: 'session-supervisor',
          dataQuality: 'medium',
          createdAt: new Date().toISOString(),
        });
        try {
          entryDecisionService.observeCrash(roundId, crashPoint);
        } catch { /* ignore */ }

        for (const name of ['regime-1', 'analytics-1', 'learning-1', 'validation-1', 'settlement-1', 'risk-1']) {
          const w = workerFleet.get(name);
          if (!w || !w.isRunning) continue;
          void w.process(payload, ctx).catch((e: unknown) =>
            logger.debug({ component: 'Composition', worker: name, error: String(e) }, 'worker process skipped')
          );
        }
      });
      logger.info({ component: 'Composition' }, 'Worker feed + history buffer wired to RoundCrashed');
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'Worker feed wire skipped');
    }

    // Feed background workers on RoundStarted as well
    try {
      eventBus.on('RoundStarted', (ev: { payload?: { roundId?: string; sessionId?: string; startedAt?: string } }) => {
        const p = ev?.payload;
        if (!p?.roundId) return;
        const ctx = {
          tenantId: null as string | null,
          correlationId: p.roundId,
          eventId: `evt-start-${p.roundId}-${Date.now()}`,
          receivedAt: new Date().toISOString(),
        };
        const payload = {
          type: 'round-started',
          roundId: p.roundId,
          sessionId: p.sessionId ?? runtime.sessionId,
          startedAt: p.startedAt ?? new Date().toISOString(),
        };
        for (const name of ['regime-1', 'analytics-1', 'learning-1', 'validation-1', 'settlement-1', 'risk-1']) {
          const w = workerFleet.get(name);
          if (!w || !w.isRunning) continue;
          void w.process(payload, ctx).catch((e: unknown) =>
            logger.debug({ component: 'Composition', worker: name, error: String(e) }, 'worker process skipped')
          );
        }
      });
      logger.info({ component: 'Composition' }, 'Worker feed wired to RoundStarted');
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'RoundStarted worker feed wire skipped');
    }

    if (telegramGateway && telegramEnabled) {
      try {
        await telegramGateway.start();
        logger.info({ component: 'Composition' }, 'Telegram bot started');
      } catch (err) {
        logger.warn({ component: 'Composition', error: String(err) }, 'Telegram start error');
      }
    }
    // Daily report scheduler (spec §5.2 + §2.9). Inlined setInterval:
    // every 24h, push a daily summary to the operator's Telegram chat.
    // Uses the virtual ledger snapshot + the analytics windowed view; if
    // the gateway isn't up, the report is logged but not sent.
    dailyReportTimer = setInterval(() => {
      void sendDailyReport();
    }, DAILY_REPORT_INTERVAL_MS);
    logger.info({ component: 'Composition', intervalMs: DAILY_REPORT_INTERVAL_MS }, 'Daily report scheduler started');
    logger.info({ component: 'Composition' }, 'Composition started');
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    logger.info({ component: 'Composition' }, 'Stopping personal-use composition');
    if (dailyReportTimer) {
      clearInterval(dailyReportTimer);
      dailyReportTimer = null;
    }
    try { dryRunController.stop(); } catch { /* ignore */ }
    try {
      await sessionSupervisor.stop();
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'SessionSupervisor stop error');
    }
    if (telegramGateway) {
      try {
        await telegramGateway.stop();
      } catch (err) {
        logger.warn({ component: 'Composition', error: String(err) }, 'Telegram stop error');
      }
    }
    await workerFleet.stopAll();
    logger.info({ component: 'Composition' }, 'Composition stopped');
  }

  /**
   * Build a daily summary and push it to the operator's Telegram chat.
   * Spec §2.9 / §5.2: this is the inlined daily-report-scheduler.
   */
  async function sendDailyReport(): Promise<void> {
    try {
      const snap = dryRunController.getLedgerSnapshot();
      const lines = [
        '*Daily Report*',
        '',
        `Mode: ${runtime.currentMode}`,
        `Session: \`${runtime.sessionId}\``,
        `Trades today: ${snap.trades}`,
        `Wins: ${snap.wins} | Losses: ${snap.losses}`,
        `Win rate: ${(snap.winRate * 100).toFixed(1)}%`,
        `Net P&L: ${snap.netPnl.toFixed(2)}`,
        `Balance: ${snap.virtualBalance.toFixed(2)} (initial ${snap.initialBalance.toFixed(2)})`,
        `Max drawdown: ${(snap.maxDrawdown * 100).toFixed(2)}%`,
      ];
      const message = lines.join('\n');
      if (telegramGateway) {
        const allowed = (config.telegram?.allowedUserIds ?? []).filter((id): id is number => typeof id === 'number');
        for (const chatId of allowed) {
          try {
            await telegramGateway.sendMessage(chatId, message);
          } catch (e) {
            logger.warn({ component: 'Composition', chatId, error: String(e) }, 'Daily report send failed');
          }
        }
      } else {
        logger.info({ component: 'Composition' }, message);
      }
    } catch (err) {
      logger.warn({ component: 'Composition', error: String(err) }, 'Daily report generation failed');
    }
  }

  return { ctx, start, stop };
}

/**
 * Global composition reference for runtime queries (e.g. /health, /state,
 * debug logs). Single-process; the personal-use build does not need a
 * Redis-backed global, but downstream code (monolith.ts, tests) expects
 * this hook to exist.
 */
let globalComposition: CompositionHandles | null = null;

export function setGlobalComposition(handles: CompositionHandles | null): void {
  globalComposition = handles;
}

export function getGlobalComposition(): CompositionHandles | null {
  return globalComposition;
}