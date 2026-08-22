import { BrowserManager } from '../browser/manager';
import { BrowserSession } from '../browser/session';
import { ProfileManager } from '../browser/profile';
import { BrowserHealthMonitor } from '../browser/health';
import { toLaunchOptions } from '../browser/types';
import { Orchestrator } from './orchestrator';
import { GameAdapter } from '../game/adapter';
import { RoundObserver } from '../game/observer';
import { EventBus } from './event-bus/bus';
import { createEvent } from './event-bus/events';
import { AppConfig } from '../config/schema';
import { getLogger } from '../observability/logger';
import { CriticalError } from '../utils/errors';
import { SelectorCanary } from '../game/selector-canary';
import { wireLiveSession, LiveWiring } from './live-session-wiring';
import { BetRepository } from '../persistence/repositories/bet-repo';

export type SupervisorPhase =
  | 'idle'
  | 'initializing'
  | 'launching-browser'
  | 'restoring-session'
  | 'authenticating'
  | 'navigating'
  | 'loading-game'
  | 'observing'
  | 'paused'
  | 'recovering'
  | 'error'
  | 'stopped';

export interface SessionSupervisorOptions {
  config: AppConfig;
  eventBus: EventBus;
}

export interface SupervisorState {
  phase: SupervisorPhase;
  sessionId: string | null;
  browserLaunched: boolean;
  authenticated: boolean;
  gameLoaded: boolean;
  observing: boolean;
  errorCount: number;
  consecutiveErrors: number;
  lastError: string | null;
  startedAt: string | null;
}

/**
 * SessionSupervisor manages the full automation session lifecycle:
 * startup -> auth -> navigation -> game load -> observation -> health monitoring -> recovery.
 *
 * It coordinates the BrowserManager, BrowserSession, ProfileManager, BrowserHealthMonitor,
 * GameAdapter, RoundObserver, and Orchestrator into a cohesive session.
 */
export class SessionSupervisor {
  private readonly options: SessionSupervisorOptions;
  private readonly logger = getLogger();
  private state: SupervisorState;
  private browserManager: BrowserManager | null = null;
  private browserSession: BrowserSession | null = null;
  private profileManager: ProfileManager | null = null;
  private healthMonitor: BrowserHealthMonitor | null = null;
  private gameAdapter: GameAdapter | null = null;
  private roundObserver: RoundObserver | null = null;
  private orchestrator: Orchestrator | null = null;
  private selectorCanary: SelectorCanary | null = null;
  private liveWiring: LiveWiring | null = null;
  private authMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private recoveryAttempts = 0;
  private maxRecoveryAttempts = 3;
  private onDegradedUnsub: (() => void) | null = null;

  constructor(options: SessionSupervisorOptions) {
    this.options = options;
    this.state = {
      phase: 'idle',
      sessionId: null,
      browserLaunched: false,
      authenticated: false,
      gameLoaded: false,
      observing: false,
      errorCount: 0,
      consecutiveErrors: 0,
      lastError: null,
      startedAt: null,
    };
  }

  async start(): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'stopped') {
      this.logger.warn({ component: 'SessionSupervisor' }, 'Session already active');
      return;
    }

    this.state.phase = 'initializing';
    this.state.startedAt = new Date().toISOString();
    this.logger.info({ component: 'SessionSupervisor' }, 'Starting session supervisor');

    try {
      // Initialize profile manager
      await this.initializeProfile();

      // Launch browser
      await this.launchBrowser();

      // Restore or authenticate session
      await this.restoreOrAuthenticate();

      // Navigate to Crash game
      await this.navigateToGame();

      // Initialize game observation
      await this.initializeObservation();
      await this.startSelectorCanary();
      await this.startLiveWiring();

      // Start health monitoring
      this.startHealthMonitoring();

      this.state.phase = 'observing';
      this.state.observing = true;

      this.logger.info(
        { component: 'SessionSupervisor', sessionId: this.state.sessionId },
        'Session supervisor fully started'
      );

      await this.options.eventBus.emit(
        createEvent(
          'SessionAuthenticated',
          { sessionId: this.state.sessionId || 'unknown', userId: 'system' },
          { correlationId: this.state.sessionId || 'unknown', source: 'SessionSupervisor' }
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'SessionSupervisor', error: message }, 'Session startup failed');
      this.state.phase = 'error';
      this.state.lastError = message;
      this.state.errorCount++;
      throw new CriticalError(`Session startup failed: ${message}`, 'SESSION_STARTUP_FAILED');
    }
  }

  async stop(): Promise<void> {
    this.logger.info({ component: 'SessionSupervisor' }, 'Stopping session supervisor');
    this.state.phase = 'stopped';
    this.state.observing = false;

    if (this.authMonitorTimer) {
      clearInterval(this.authMonitorTimer);
      this.authMonitorTimer = null;
    }
    if (this.liveWiring) {
      try {
        this.liveWiring.stop();
      } catch {
        /* ignore */
      }
      this.liveWiring = null;
    }
    // Stop canary
    if (this.selectorCanary) {
      try {
        this.selectorCanary.stop();
      } catch {
        /* ignore */
      }
      this.selectorCanary = null;
    }

    // Stop health monitoring
    this.stopHealthMonitoring();

    // Stop orchestrator
    if (this.orchestrator) {
      try {
        await this.orchestrator.stop();
      } catch (err) {
        this.logger.warn({ component: 'SessionSupervisor', error: String(err) }, 'Error stopping orchestrator');
      }
    }

    // Stop observer
    if (this.roundObserver) {
      try {
        await this.roundObserver.stop();
      } catch (err) {
        this.logger.warn({ component: 'SessionSupervisor', error: String(err) }, 'Error stopping observer');
      }
    }

    // Stop adapter
    if (this.gameAdapter) {
      try {
        await this.gameAdapter.stop();
      } catch (err) {
        this.logger.warn({ component: 'SessionSupervisor', error: String(err) }, 'Error stopping adapter');
      }
    }

    // Save session state
    if (this.browserSession && this.browserManager?.getContext()) {
      try {
        await this.browserSession.captureAndSave(this.browserManager.getContext());
      } catch (err) {
        this.logger.warn({ component: 'SessionSupervisor', error: String(err) }, 'Error saving session');
      }
    }

    // Close browser
    if (this.browserManager) {
      try {
        await this.browserManager.close();
      } catch (err) {
        this.logger.warn({ component: 'SessionSupervisor', error: String(err) }, 'Error closing browser');
      }
      this.browserManager = null;
    }

    this.state.browserLaunched = false;
    this.state.authenticated = false;
    this.state.gameLoaded = false;

    this.logger.info({ component: 'SessionSupervisor' }, 'Session supervisor stopped');
  }

  async pause(): Promise<void> {
    if (this.state.phase === 'paused') return;

    this.logger.info({ component: 'SessionSupervisor' }, 'Pausing session');
    this.state.phase = 'paused';
    this.state.observing = false;

    if (this.orchestrator) {
      await this.orchestrator.stop();
    }

    await this.options.eventBus.emit(
      createEvent(
        'SystemPaused',
        { reason: 'Operator pause', pausedBy: 'session-supervisor' },
        { correlationId: this.state.sessionId || 'unknown', source: 'SessionSupervisor' }
      )
    );
  }

  async resume(): Promise<void> {
    if (this.state.phase !== 'paused') return;

    this.logger.info({ component: 'SessionSupervisor' }, 'Resuming session');

    if (this.browserManager?.isLaunched() && this.gameAdapter) {
      this.state.phase = 'observing';
      this.state.observing = true;

      if (this.orchestrator) {
        await this.orchestrator.start();
      }

      await this.options.eventBus.emit(
        createEvent(
          'SystemResumed',
          { resumedBy: 'session-supervisor' },
          { correlationId: this.state.sessionId || 'unknown', source: 'SessionSupervisor' }
        )
      );
    } else {
      // Need to restart
      await this.start();
    }
  }

  async recover(): Promise<void> {
    if (this.recoveryAttempts >= this.maxRecoveryAttempts) {
      this.logger.error(
        { component: 'SessionSupervisor', attempts: this.recoveryAttempts },
        'Max recovery attempts reached, stopping'
      );
      await this.stop();
      throw new CriticalError('Max recovery attempts reached', 'MAX_RECOVERY_EXCEEDED');
    }

    this.recoveryAttempts++;
    this.state.phase = 'recovering';
    this.logger.info(
      { component: 'SessionSupervisor', attempt: this.recoveryAttempts },
      'Attempting recovery'
    );

    // Spec-upgrade: drive FSM into RECONCILING so outbound bets stay blocked
    // until REST order status is resolved.
    try {
      void this.options.eventBus.emit({
        type: 'RECONCILE' as any,
        source: 'SessionSupervisor',
        timestamp: new Date().toISOString(),
        payload: { reason: 'recovery', attempt: this.recoveryAttempts },
      } as any);
    } catch {
      /* non-fatal */
    }

    try {
      // Stop current components
      if (this.orchestrator) await this.orchestrator.stop();
      if (this.roundObserver) await this.roundObserver.stop();
      if (this.gameAdapter) await this.gameAdapter.stop();

      // Reload page
      if (this.browserManager) {
        await this.browserManager.reload();
      }

      // Re-initialize
      await this.initializeObservation();
      this.state.phase = 'observing';
      this.state.observing = true;

      this.logger.info({ component: 'SessionSupervisor' }, 'Recovery successful');
      this.recoveryAttempts = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'SessionSupervisor', error: message }, 'Recovery failed');
      this.state.phase = 'error';
      this.state.lastError = message;
      throw new CriticalError(`Recovery failed: ${message}`, 'RECOVERY_FAILED');
    }
  }

  private async initializeProfile(): Promise<void> {
    this.profileManager = new ProfileManager({
      baseDirectory: this.options.config.browser.profileDirectory,
    });
    await this.profileManager.initialize();
  }

  private async launchBrowser(): Promise<void> {
    this.state.phase = 'launching-browser';

    const profile = await this.profileManager!.getOrCreateProfile();
    const launchOptions = toLaunchOptions(this.options.config.browser, this.options.config.proxy, this.options.config.system.mode);
    launchOptions.userDataDir = profile.directory;

    this.browserManager = new BrowserManager(launchOptions);

    // Listen for lifecycle events
    this.browserManager.onLifecycle((event) => {
      this.logger.debug(
        { component: 'SessionSupervisor', phase: event.phase, detail: event.detail },
        'Browser lifecycle event'
      );
    });

    await this.browserManager.launch();
    this.state.browserLaunched = true;

    this.logger.info({ component: 'SessionSupervisor' }, 'Browser launched');
  }

  private async restoreOrAuthenticate(): Promise<void> {
    this.state.phase = 'restoring-session';

    const profile = this.profileManager!.listProfiles()[0];
    if (!profile) {
      throw new CriticalError('No browser profile available', 'NO_PROFILE');
    }

    this.browserSession = new BrowserSession({
      profileDirectory: profile.directory,
    });

    // Try to restore saved session
    const savedSession = await this.browserSession.restoreIfAvailable(this.browserManager!.getContext());

    if (savedSession) {
      this.logger.info({ component: 'SessionSupervisor' }, 'Session restored from saved state');
    }

    // Check authentication status
    this.state.phase = 'authenticating';
    const authResult = await this.browserSession.checkAuthentication(this.browserManager!.getPage());

    if (authResult.authenticated) {
      this.state.authenticated = true;
      this.logger.info(
        { component: 'SessionSupervisor', method: authResult.method },
        'Authentication verified'
      );
    } else {
      this.logger.warn(
        { component: 'SessionSupervisor' },
        'Not authenticated - operator must log in manually'
      );
      // In observe-only mode, we can still observe without being logged in
      // but we should notify the operator
    }

    // Save session state
    await this.browserSession.captureAndSave(this.browserManager!.getContext());
  }

  private async navigateToGame(): Promise<void> {
    this.state.phase = 'navigating';

    const result = await this.browserManager!.navigate('https://bc.game/crash');

    if (!result.success) {
      this.logger.warn(
        { component: 'SessionSupervisor', error: result.error },
        'Navigation may have issues, continuing...'
      );
    }

    this.state.phase = 'loading-game';

    // Wait a moment for game to load
    await new Promise((resolve) => setTimeout(resolve, 3000));

    this.state.gameLoaded = true;
    this.logger.info({ component: 'SessionSupervisor', url: result.url }, 'Navigated to Crash game');
  }

  private async initializeObservation(): Promise<void> {
    this.state.phase = 'observing';

    // Create game adapter with multi-source observation enabled by default (P0.4)
    this.gameAdapter = new GameAdapter({
      page: this.browserManager!.getPage(),
      enableDomAdapter: true,
      enableWsAdapter: true,
      enableApiAdapter: true,
      pollIntervalMs: 100,
    });

    // Create round observer
    this.roundObserver = new RoundObserver({
      adapter: this.gameAdapter,
      minConfidenceForEntry: this.options.config.observation.minConfidenceForEntry,
      maxLatencyMs: this.options.config.observation.maxTickLatencyMs,
    });

    // Repositories and related services MUST be injected via constructor / DI container.
    // No silent creation of dummy repositories (P0.6).

    this.logger.info({ component: 'SessionSupervisor' }, 'Observation initialized (multi-source)');
  }

  private startHealthMonitoring(): void {
    this.healthMonitor = new BrowserHealthMonitor({
      frozenThresholdMs: 5000,
      memoryThresholdMB: 512,
      tickTimeoutMs: 3000,
    });

    this.onDegradedUnsub = this.healthMonitor.onDegraded((metrics) => {
      this.logger.warn(
        {
          component: 'SessionSupervisor',
          frozen: metrics.frozen,
          memoryMB: metrics.jsHeapSizeMB,
          wsConnected: metrics.wsConnected,
        },
        'Browser health degraded'
      );

      this.state.consecutiveErrors++;

      if (metrics.frozen) {
        this.handleFrozenBrowser();
      }
    });

    // Start periodic checks
    if (this.browserManager?.getPage()) {
      this.healthMonitor.start(this.browserManager.getPage(), 5000);
    }
  }

  private stopHealthMonitoring(): void {
    if (this.healthMonitor) {
      this.healthMonitor.stop();
      this.healthMonitor = null;
    }
    if (this.onDegradedUnsub) {
      this.onDegradedUnsub();
      this.onDegradedUnsub = null;
    }
  }

  private async handleFrozenBrowser(): Promise<void> {
    this.logger.error({ component: 'SessionSupervisor' }, 'Browser appears frozen, attempting recovery');
    this.state.errorCount++;

    try {
      await this.recover();
    } catch (error) {
      this.logger.error(
        { component: 'SessionSupervisor', error: String(error) },
        'Recovery from frozen state failed'
      );
      await this.stop();
    }
  }



  private async startLiveWiring(): Promise<void> {
    if (!this.browserManager || !this.browserSession) return;
    const page = this.browserManager.getPage();
    if (!page) return;

    const mode = this.options.config.system.mode;
    try {
      let betRepo: BetRepository | undefined;
      try {
        betRepo = new BetRepository();
      } catch {
        betRepo = undefined;
      }

      this.liveWiring = wireLiveSession({
        page,
        config: this.options.config,
        eventBus: this.options.eventBus,
        browserSession: this.browserSession,
        betRepo,
        onPause: async () => {
          await this.pause();
        },
        onResume: async () => {
          await this.resume();
        },
        onRotationNeeded: async (payload) => {
          this.logger.warn(
            { component: 'SessionSupervisor', payload },
            'Profile rotation requested — pausing and marking rotator complete after cool-down'
          );
          await this.pause();
          // ProfileManager rotate if available; otherwise mark rotation complete after quarantine window
          try {
            if (this.profileManager) {
              await this.profileManager.requestRotation();
            }
          } catch (err) {
            this.logger.error(
              { component: 'SessionSupervisor', error: String(err) },
              'Profile rotation failed'
            );
          }
          this.liveWiring?.sessionRotator.completeRotation(
            this.browserManager?.getState?.()?.profileId ?? undefined
          );
        },
      });
      if (this.liveWiring.selectorCanary) {
        this.selectorCanary = this.liveWiring.selectorCanary;
      }

      if (this.authMonitorTimer) clearInterval(this.authMonitorTimer);
      this.authMonitorTimer = setInterval(() => {
        void this.liveWiring?.sessionConsistency
          .monitorAuthLoss(page, async () => {
            await this.liveWiring?.reauthProtocol.requestReauth('auth_loss_detected');
          })
          .catch(() => undefined);
      }, 60_000);
      if (typeof this.authMonitorTimer === 'object' && 'unref' in this.authMonitorTimer) {
        (this.authMonitorTimer as NodeJS.Timeout).unref();
      }

      this.logger.info(
        {
          component: 'SessionSupervisor',
          mode,
          liveBet: !!this.liveWiring.liveBetExecutor,
          liveCashOut: !!this.liveWiring.liveCashOutExecutor,
        },
        'Live session wiring started'
      );
    } catch (err) {
      this.logger.error(
        { component: 'SessionSupervisor', error: String(err) },
        'Live wiring failed'
      );
      if (mode === 'live') {
        throw err;
      }
    }
  }

  getLiveWiring(): LiveWiring | null {
    return this.liveWiring;
  }

  private async startSelectorCanary(): Promise<void> {
    try {
      const page = this.browserManager?.getPage?.();
      if (!page) {
        this.logger.warn({ component: 'SessionSupervisor' }, 'No page for selector canary');
        return;
      }
      this.selectorCanary = new SelectorCanary({
        page,
        intervalMs: this.options.config.browser.canaryIntervalMs ?? 30_000,
        onCritical: (report) => {
          this.logger.error(
            { component: 'SessionSupervisor', report },
            'Selector canary critical failure — pausing session'
          );
          void this.pause().catch((err) =>
            this.logger.warn({ component: 'SessionSupervisor', error: String(err) }, 'Pause after canary failed')
          );
          void this.options.eventBus.emit(
            createEvent(
              'SystemPaused',
              { reason: 'Selector canary critical failure', pausedBy: 'selector-canary' },
              { correlationId: this.state.sessionId || 'unknown', source: 'SessionSupervisor' }
            )
          );
        },
      });
      this.selectorCanary.start();
      this.logger.info({ component: 'SessionSupervisor' }, 'Selector canary started');
    } catch (err) {
      this.logger.warn(
        { component: 'SessionSupervisor', error: String(err) },
        'Failed to start selector canary'
      );
    }
  }

  getState(): Readonly<SupervisorState> {
    return { ...this.state };
  }

  isObserving(): boolean {
    return this.state.phase === 'observing';
  }

  getPhase(): SupervisorPhase {
    return this.state.phase;
  }

  getBrowserManager(): BrowserManager | null {
    return this.browserManager;
  }

  getGameAdapter(): GameAdapter | null {
    return this.gameAdapter;
  }

  getRoundObserver(): RoundObserver | null {
    return this.roundObserver;
  }

  getHealthMonitor(): BrowserHealthMonitor | null {
    return this.healthMonitor;
  }
}
