/**
 * Live session wiring — constructs HumanInput, SelectorCanary, ChallengeDetector,
 * SessionRotator, LiveBetExecutor, LiveCashOutExecutor for the production path.
 */

import { Page } from 'playwright';

import { AppConfig } from '../config/schema';
import { getLogger } from '../observability/logger';
import { CriticalError } from '../utils/errors';
import { HumanInput } from '../browser/human-input';
import { Humanizer } from '../browser/humanize';
import { SelectorCanary } from '../game/selector-canary';
import { ChallengeDetector } from '../browser/challenge-detector';
import { SessionRotator } from '../browser/session-rotator';
import { LiveBetExecutor } from '../betting/live-executor';
import { LiveCashOutExecutor } from '../betting/live-cashout';
import { ConfirmationObserver } from '../betting/confirmation';
import { ExecutionSafeguards } from '../betting/execution-safeguards';
import { BetRepository } from '../persistence/repositories/bet-repo';
import { BalanceTracker } from '../ledger/balance-tracker';
import { DailyEntryCounter } from '../ledger/daily-entries';
import { VelocityController } from '../risk/velocity-controller';
import { TelemetryNoise } from '../betting/telemetry-noise';
import { IdempotencyKeyStore } from '../betting/idempotency';
import { ReauthProtocol } from '../browser/reauth-protocol';
import { BrowserSession } from '../browser/session';
import { SessionConsistencyManager } from '../browser/session-consistency';
import { InMemoryCapitalGuard } from '../capital/in-memory-limits';
import { ClientOrderIdRegistry } from './reconciliation-service';
import { HashChainVerifier } from '../risk/provably-fair/hash-chain';
import { PayloadCircuitBreaker } from '../protocol/ws-payload-schemas';
import { AuthoritativeSettlementEngine } from '../settlement/authoritative-settlement-engine';
import { DriftGuard } from '../settlement/drift-guard';
import { NullEvidenceProvider, RestHistoryEvidenceProvider, type SettlementEvidenceProvider } from '../settlement/evidence-provider';
import { createAuthoritativeBetReader, createAuthoritativeCashOutReader } from '../settlement/authoritative-readers';
import { getPool } from '../persistence/client';

import { EventBus } from './event-bus/bus';

export interface LiveWiring {
  humanInput: HumanInput;
  humanizer: Humanizer;
  selectorCanary: SelectorCanary;
  challengeDetector: ChallengeDetector;
  sessionRotator: SessionRotator;
  liveBetExecutor: LiveBetExecutor | null;
  liveCashOutExecutor: LiveCashOutExecutor | null;
  velocityController: VelocityController;
  telemetryNoise: TelemetryNoise;
  reauthProtocol: ReauthProtocol;
  sessionConsistency: SessionConsistencyManager;
  confirmationObserver: ConfirmationObserver;
  /** Optional coordinator bound after wire (set by SessionSupervisor) */
  bettingCoordinator: import('../betting/betting-coordinator').BettingCoordinator | null;
  capitalGuard: InMemoryCapitalGuard | null;
  orderRegistry: ClientOrderIdRegistry;
  hashVerifier: HashChainVerifier | null;
  circuitBreaker: PayloadCircuitBreaker | null;
  settlementEngine: AuthoritativeSettlementEngine | null;
  driftGuard: DriftGuard | null;
  stop(): void;
}

export interface LiveWiringOptions {
  page: Page;
  config: AppConfig;
  eventBus: EventBus;
  browserSession: BrowserSession;
  betRepo?: BetRepository;
  balanceTracker?: BalanceTracker;
  dailyCounter?: DailyEntryCounter;
  onPause: () => Promise<void>;
  onResume?: () => Promise<void>;
  notify?: (message: string) => Promise<void>;
  /** Called when SessionRotator requests profile rotation — implementer should pause and rotate profile */
  onRotationNeeded?: (payload: { reason?: string; profileId?: string | null }) => Promise<void>;
}

export function wireLiveSession(options: LiveWiringOptions): LiveWiring {
  const logger = getLogger();
  const { page, config, eventBus, browserSession, betRepo, onPause, onResume, notify } = options;
  const mode = config.system.mode;
  const isLive = mode === 'live';

  const humanizeEnabled = config.behavioral?.enabled !== false || isLive;
  const humanInput = new HumanInput(page, {
    enabled: humanizeEnabled,
    minActionDelayMs: config.behavioral?.clickDelayMinMs ?? 70,
    maxActionDelayMs: config.behavioral?.clickDelayMaxMs ?? 450,
    mouseBezier: true,
    typeInsteadOfFill: true,
    requirePrecedingMouseMove: true,
  });

  const humanizer = new Humanizer({
    enabled: humanizeEnabled,
    mouseStepsMin: config.behavioral?.mouseStepsMin ?? 8,
    mouseStepsMax: config.behavioral?.mouseStepsMax ?? 22,
    mouseOvershootPx: config.behavioral?.mouseOvershootPx ?? 12,
    clickDelayMinMs: config.behavioral?.clickDelayMinMs ?? 35,
    clickDelayMaxMs: config.behavioral?.clickDelayMaxMs ?? 130,
    typeDelayMinMs: config.behavioral?.typeDelayMinMs ?? 30,
    typeDelayMaxMs: config.behavioral?.typeDelayMaxMs ?? 95,
  });

  if (isLive && !humanInput.isEnabled()) {
    throw new CriticalError(
      'Live mode requires HumanInput enabled',
      'LIVE_HUMANINPUT_REQUIRED'
    );
  }

  const selectorCanary = new SelectorCanary({
    page,
    intervalMs: config.browser.canaryIntervalMs ?? 30_000,
    onCritical: (report) => {
      logger.error({ component: 'LiveWiring', report }, 'Canary critical — pausing');
      void onPause();
    },
  });
  selectorCanary.start();

  const sessionRotator = new SessionRotator({
    maxAgeHours: config.browser.session?.maxAgeHours ?? 12,
    maxContinuousActiveMinutes: config.browser.session?.maxContinuousActiveMinutes ?? 150,
    rotationJitterMinutes: config.browser.session?.rotationJitterMinutes ?? 25,
    quarantineOnChallenge: config.browser.session?.quarantineOnChallenge ?? true,
    minWarmStandbyProfiles: config.browser.session?.minWarmStandbyProfiles ?? 1,
  });

  const challengeDetector = new ChallengeDetector({
    page,
    intervalMs: 5_000,
    onChallenge: (event) => {
      logger.warn({ component: 'LiveWiring', event }, 'Challenge detected');
      sessionRotator.onChallenge(event);
      void onPause();
      void notify?.(
        `⚠️ Challenge detected: ${event.kind}\n${event.detail}\nSession pausing.`
      );
    },
  });
  challengeDetector.start();

  sessionRotator.transition('Warming');
  sessionRotator.transition('Authenticated');
  sessionRotator.transition('Active');
  sessionRotator.startMonitoring(30_000);
  sessionRotator.on('rotation-needed', (payload) => {
    const p = payload as { reason?: string; profileId?: string | null };
    logger.warn({ component: 'LiveWiring', payload: p }, 'Session rotation needed');
    void onPause();
    void notify?.(
      `🔄 Session rotation needed: ${String(p?.reason ?? payload)}\nProfile: ${p?.profileId ?? 'n/a'}`
    );
    if (options.onRotationNeeded) {
      void options.onRotationNeeded(p).catch((err) =>
        logger.error({ component: 'LiveWiring', error: String(err) }, 'onRotationNeeded failed')
      );
    }
  });
  sessionRotator.on('quarantine', () => {
    void onPause();
  });

  const velocityController = new VelocityController(
    config.velocity ?? {
      enabled: true,
      minActionIntervalMs: 8000,
      maxActionIntervalMs: 25000,
      maxActionsPerMinute: 4,
      maxActionsPerHour: 60,
      idleProbability: 0.12,
      minIdleMs: 30000,
      maxIdleMs: 180000,
      cashOutJitterMs: 180,
    }
  );

  const telemetryNoise = new TelemetryNoise(
    config.telemetryNoise ?? {
      enabled: false,
      cashOutTargetNoise: 0.015,
      skipEntryProbability: 0.04,
      delayedCashOutProbability: 0.03,
    }
  );

  const reauthProtocol = new ReauthProtocol(browserSession, eventBus);
  reauthProtocol.setHooks({ onPause, onResume, notify });

  const sessionConsistency = new SessionConsistencyManager(
    config.sessionConsistency ?? {
      maxSessionAgeHours: 72,
      requireAuthOnStart: true,
      pauseOnAuthLoss: true,
      profileSticky: true,
    },
    browserSession,
    eventBus
  );

  const confirmationObserver = new ConfirmationObserver(page);

  let capitalGuard: InMemoryCapitalGuard | null = null;
  let orderRegistry = new ClientOrderIdRegistry();
  let hashVerifier: HashChainVerifier | null = null;
  let circuitBreaker: PayloadCircuitBreaker | null = null;
  let settlementEngine: AuthoritativeSettlementEngine | null = null;
  let driftGuard: DriftGuard | null = null;

  let liveBetExecutor: LiveBetExecutor | null = null;
  let liveCashOutExecutor: LiveCashOutExecutor | null = null;

  if ((mode === 'live' || mode === 'dry-run') && betRepo) {
    const balanceTracker = options.balanceTracker ?? new BalanceTracker();
    const dailyCounter = options.dailyCounter ?? new DailyEntryCounter();
    const safeguards = new ExecutionSafeguards(balanceTracker, dailyCounter, config);

    const idempotency = new IdempotencyKeyStore();

    // Spec-upgrade: capital isolation + client_order_id + biomechanical
    const su = (config as any).specUpgrade ?? {};
    const capitalCfg = su.capital ?? {};
    capitalGuard =
      capitalCfg.enabled !== false
        ? new InMemoryCapitalGuard({
            maxDrawdownAbs: capitalCfg.maxDrawdownAbs ?? 5000,
            maxDrawdownPct: capitalCfg.maxDrawdownPct ?? 0.25,
            panicBalanceFloor: capitalCfg.panicBalanceFloor ?? 500,
            maxStake: config.betting?.stakePerEntry ?? 700,
            startingBankroll: options.balanceTracker
              ? (options.balanceTracker as any).getBalance?.() ?? config.risk?.minBalanceForEntry ?? 700
              : config.risk?.minBalanceForEntry ?? 700,
          })
        : null;
    orderRegistry = new ClientOrderIdRegistry();
    hashVerifier =
      su.provablyFair?.enabled !== false
        ? new HashChainVerifier(undefined, su.provablyFair?.maxHashFailures ?? 3)
        : null;
    circuitBreaker =
      su.payloadIngestion?.enabled !== false
        ? new PayloadCircuitBreaker(su.payloadIngestion?.circuitBreakerThreshold ?? 8, () => {
            logger.error({ component: 'LiveWiring' }, 'WS payload circuit breaker tripped');
            void onPause();
          })
        : null;
    const useBiomechanical = su.stealth?.biomechanicalInput !== false;

    const settleCfg = su.settlement ?? {};
    if (settleCfg.enabled !== false) {
      try {
        settlementEngine = new AuthoritativeSettlementEngine(getPool());
        if (settleCfg.driftEnabled !== false) {
          driftGuard = new DriftGuard(
            settlementEngine,
            async () => {
              // Placeholder: operator must inject real remote balance reader
              return options.balanceTracker
                ? Number((options.balanceTracker as any).getBalance?.() ?? 0)
                : 0;
            },
            {
              threshold: settleCfg.driftThreshold ?? 0.0001,
              enabled: true,
              pollIntervalMs: settleCfg.driftPollIntervalMs ?? 30000,
            },
            eventBus,
            () => void onPause()
          );
          driftGuard.start();
        }
      } catch (e) {
        logger.warn({ component: 'LiveWiring', error: String(e) }, 'Settlement engine init deferred (pool may be unavailable)');
      }
    }

    liveBetExecutor = new LiveBetExecutor(


      page,
      betRepo,
      confirmationObserver,
      safeguards,
      eventBus,
      undefined,
      selectorCanary,
      humanInput,
      velocityController,
      humanizer,
      telemetryNoise,
      idempotency,
      capitalGuard ?? undefined,
      orderRegistry,
      useBiomechanical,
      settlementEngine ?? undefined
    );

    liveCashOutExecutor = new LiveCashOutExecutor(page, betRepo, confirmationObserver, eventBus);
    liveCashOutExecutor.setVelocityController(velocityController);
    liveCashOutExecutor.attachHumanization(humanizer, humanInput, selectorCanary);
    if (settlementEngine) {
      liveCashOutExecutor.setSettlementEngine(settlementEngine);
    }

    // Authoritative readers from evidence provider → ConfirmationObserver
    // reuse settleCfg from settlement engine block
    let evidenceProvider: SettlementEvidenceProvider | null = null;
    if (settleCfg.evidenceProvider === 'rest_history' && settleCfg.evidenceBaseUrl) {
      evidenceProvider = new RestHistoryEvidenceProvider({
        baseUrl: settleCfg.evidenceBaseUrl,
        headers: process.env.SETTLEMENT_EVIDENCE_HEADERS
          ? JSON.parse(process.env.SETTLEMENT_EVIDENCE_HEADERS)
          : undefined,
      });
    } else if (settleCfg.enabled !== false) {
      evidenceProvider = new NullEvidenceProvider();
    }
    if (evidenceProvider) {
      const coidByRound = new Map<string, string>();
      const coidByBet = new Map<string, string>();
      try {
        eventBus.on('ClientOrderIdBound', (evt: any) => {
          const payload = evt?.payload ?? evt;
          if (payload?.clientOrderId) {
            if (payload.roundId) coidByRound.set(String(payload.roundId), payload.clientOrderId);
            if (payload.betId) coidByBet.set(String(payload.betId), payload.clientOrderId);
          }
        });
      } catch { /* optional */ }
      confirmationObserver.setAuthoritativeBetReader(
        createAuthoritativeBetReader(evidenceProvider, (roundId) => coidByRound.get(roundId))
      );
      confirmationObserver.setAuthoritativeCashOutReader(
        createAuthoritativeCashOutReader(evidenceProvider, (betId) => coidByBet.get(betId))
      );
      logger.info({ component: 'LiveWiring', provider: settleCfg.evidenceProvider ?? 'null' }, 'Authoritative confirmation readers attached');
    }
    // Bind client_order_id from placement to cash-out settlement
    try {
      eventBus.on('ClientOrderIdBound', (evt: any) => {
        const payload = evt?.payload ?? evt;
        if (payload?.betId && payload?.clientOrderId) {
          liveCashOutExecutor?.registerClientOrderId(payload.betId, payload.clientOrderId);
        }
      });
    } catch {
      /* EventBus API may differ */
    }
  }

  logger.info(
    {
      component: 'LiveWiring',
      mode,
      humanInput: humanInput.isEnabled(),
      liveBet: !!liveBetExecutor,
      liveCashOut: !!liveCashOutExecutor,
    },
    'Live session wiring complete'
  );

  return {
    humanInput,
    humanizer,
    selectorCanary,
    challengeDetector,
    sessionRotator,
    liveBetExecutor,
    liveCashOutExecutor,
    velocityController,
    telemetryNoise,
    reauthProtocol,
    sessionConsistency,
    confirmationObserver,
    bettingCoordinator: null,
    capitalGuard,
    orderRegistry,
    hashVerifier,
    circuitBreaker,
    settlementEngine,
    driftGuard,
    stop() {
      selectorCanary.stop();
      challengeDetector.stop();
      sessionRotator.stopMonitoring();
      liveBetExecutor?.stop();
      driftGuard?.stop();
    },
  };
}
