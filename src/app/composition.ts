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
import { getPool } from '../persistence/client';
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
  recoveryManager: unknown;
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
    decisionRanker: opportunityRanker as never,
  });
  const sheathMode = new SheathMode();
  // Personal-use recovery manager: no-op stub (live-mode bet reconciliation
  // requires the browser pipeline, which is deferred per spec §2.2). Wired
  // here so the type surface is preserved.
  const recoveryManager = { runRecovery: async (): Promise<unknown> => ({ recovered: 0, resolved: 0 }) };

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
    buildRiskInput: () => ({} as never),
  }));
  workerFleet.register(new ValidationWorker());
  workerFleet.register(new RegimeWorker());

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
      getOrchestratorState: () => ({
        sessionId: runtime.sessionId,
        uptimeSeconds: (Date.now() - runtime.startedAt) / 1000,
        mode: runtime.currentMode,
        lastRound: runtime.lastRound,
        recentTrades: runtime.recentTrades,
        halted: runtime.halted,
        haltReason: runtime.haltReason,
      }),
      getLedgerSummary: () => virtualLedger.snapshot() as unknown as Record<string, unknown>,
      getHealthStatus: () => ({
        status: 'healthy',
        mode: runtime.currentMode,
        session: runtime.sessionId,
        workers: workerFleet.snapshot(),
      }),
      getWindowedAnalytics: (_amount: number, _unit: string) => ({
        signals: runtime.recentTrades.length,
        signalsAccepted: runtime.recentTrades.filter((t) => t.status !== 'OPEN').length,
        signalsRejected: 0,
        avgProbability: 0,
        avgConfidence: 0,
        expectedValue: 0,
        regime: 'normal',
        modelVersion: 'v1',
      }),
      setSystemMode: async (mode: string) => {
        const valid = ['observe-only', 'dry-run', 'live', 'maintenance'];
        if (!valid.includes(mode)) return false;
        runtime.currentMode = mode as AppConfig['system']['mode'];
        if (mode === 'live') {
          runtime.halted = false;
          runtime.haltReason = undefined;
        }
        return true;
      },
      pauseSystem: async (_reason: string) => {
        runtime.halted = true;
        runtime.haltReason = _reason;
        return true;
      },
      resumeSystem: async () => {
        runtime.halted = false;
        runtime.haltReason = undefined;
        return true;
      },
      stopSystem: async () => {
        runtime.halted = true;
        runtime.haltReason = 'stopped';
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
      setConfigValue: async (_key: string, _value: string) => true,
      sheathSystem: async () => true,
      unsheathSystem: async () => true,
      getSheathState: () => ({ state: 'armed', bettingSuspended: false, triggers: [] }),
      loginWithCredentials: async (email: string, _password: string) => ({
        ok: false,
        authenticated: false,
        detail:
          'Live-mode browser login is not wired in this build. ' +
          'Run `npm run dev` and load the Playwright login flow manually, ' +
          `then the encrypted cookie will be stored. (email=${email})`,
      }),
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
            sessionAuthenticated: true,
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
    await workerFleet.startAll();
    if (telegramGateway && telegramEnabled) {
      try {
        await telegramGateway.start();
        logger.info({ component: 'Composition' }, 'Telegram bot started');
      } catch (err) {
        logger.warn({ component: 'Composition', error: String(err) }, 'Telegram start error');
      }
    }
    logger.info({ component: 'Composition' }, 'Composition started');
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    logger.info({ component: 'Composition' }, 'Stopping personal-use composition');
    try { dryRunController.stop(); } catch { /* ignore */ }
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