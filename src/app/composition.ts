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
 *   - telegram gateway
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
// RecoveryManager removed for personal-use; no live bets to reconcile in dry-run.
// In live mode, this will be reintroduced behind a dynamic import.
import { TelegramGateway } from '../telegram/gateway';
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
  workerFleet: WorkerFleet;
  telegramGateway: TelegramGateway | null;
  telegramEnabled: boolean;
  halted: boolean;
  haltReason?: string;
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
  const recoveryManager = { runRecovery: async () => ({} as never) } as never;

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

  // Telegram gateway (created lazily; not started in maintenance mode)
  const telegramEnabled = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  let telegramGateway: TelegramGateway | null = null;

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
    workerFleet,
    telegramGateway,
    telegramEnabled,
    halted: false,
  };

  let started = false;

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    logger.info({ component: 'Composition' }, 'Starting personal-use composition');
    await workerFleet.startAll();
    logger.info({ component: 'Composition' }, 'Composition started');
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    logger.info({ component: 'Composition' }, 'Stopping personal-use composition');
    await workerFleet.stopAll();
    if (telegramGateway) {
      try {
        await telegramGateway.stop();
      } catch (err) {
        logger.warn({ component: 'Composition', error: String(err) }, 'Telegram stop error');
      }
    }
    logger.info({ component: 'Composition' }, 'Composition stopped');
  }

  return { ctx, start, stop };
}