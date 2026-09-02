/**
 * SessionSupervisor — personal-use BC.Game auth + observation lifecycle.
 *
 * Owns browser launch, encrypted session restore, credential login,
 * navigation to Crash, GameAdapter + RoundObserver, and emission of
 * RoundStarted / RoundCrashed onto the shared EventBus.
 *
 * After successful /login the browser stays alive (no one-shot teardown).
 */

import path from 'path';
import { EventEmitter } from 'events';

import type { AppConfig } from '../config/schema';
import { getLogger } from '../observability/logger';
import { CriticalError } from '../utils/errors';
import { BrowserManager } from '../browser/manager';
import { BrowserSession } from '../browser/session';
import { ProfileManager } from '../browser/profile';
import { BrowserHealthMonitor } from '../browser/health';
import { toLaunchOptions } from '../browser/types';
import {
  runLoginTestPipeline,
  type LoginStatus,
  type LoginTestReport,
} from '../browser/login-test-pipeline';
import { maskEmail } from '../security/ephemeral-login';
import { runNetworkPreflight } from '../browser/preflight';
import { GameAdapter } from '../game/adapter';
import { RoundObserver } from '../game/observer';
import { BC_GAME_URLS } from '../game/constants';
import { EventBus } from './event-bus/bus';
import { createEvent } from './event-bus/events';
import { DryRunController } from './dry-run/dry-run-controller';

export type SupervisorPhase =
  | 'idle'
  | 'initializing'
  | 'launching-browser'
  | 'restoring-session'
  | 'authenticating'
  | 'auth-required'
  | 'browser-failed'
  | 'region-blocked'
  | 'navigating'
  | 'loading-game'
  | 'observing'
  | 'paused'
  | 'recovering'
  | 'error'
  | 'stopped'
  | 'preflight-failed';

export interface SessionSupervisorOptions {
  config: AppConfig;
  eventBus: EventBus;
  dryRunController?: DryRunController | null;
  sessionId?: string;
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
  loginStatus: LoginStatus;
  lastLoginReport: LoginTestReport | null;
}

export interface LoginOutcome {
  ok: boolean;
  authenticated: boolean;
  regionBlocked?: boolean;
  gameLoaded?: boolean;
  observing?: boolean;
  detail?: string;
  code?: string;
  maskedEmail?: string;
  loginReport?: LoginTestReport;
  pageState?: string;
}

export class SessionSupervisor {
  private readonly options: SessionSupervisorOptions;
  private readonly logger = getLogger().child({ component: 'SessionSupervisor' });
  private state: SupervisorState;

  private browserManager: BrowserManager | null = null;
  private browserSession: BrowserSession | null = null;
  private profileManager: ProfileManager | null = null;
  private healthMonitor: BrowserHealthMonitor | null = null;
  private gameAdapter: GameAdapter | null = null;
  private roundObserver: RoundObserver | null = null;
  private dryRunController: DryRunController | null = null;
  private signalEvaluator: ((roundId: string) => void | Promise<void>) | null = null;
  private readonly phaseEmitter = new EventEmitter();
  private unsubRoundStart: (() => void) | null = null;
  private unsubRoundComplete: (() => void) | null = null;

  constructor(options: SessionSupervisorOptions) {
    this.options = options;
    this.dryRunController = options.dryRunController ?? null;
    this.state = {
      phase: 'idle',
      sessionId: options.sessionId ?? null,
      browserLaunched: false,
      authenticated: false,
      gameLoaded: false,
      observing: false,
      errorCount: 0,
      consecutiveErrors: 0,
      lastError: null,
      startedAt: null,
      loginStatus: 'NOT_TESTED',
      lastLoginReport: null,
    };
  }

  async start(): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'stopped') {
      this.logger.warn({ phase: this.state.phase }, 'Supervisor already started');
      return;
    }
    this.setPhase('initializing');
    this.state.startedAt = new Date().toISOString();
    const mode = String(this.options.config.system.mode ?? 'dry-run').toLowerCase();

    try {
      await this.initializeProfile();
      await this.launchBrowser();
      await this.restoreSessionState();
      await this.refreshAuthStatusFromPage();

      if (mode === 'dry-run' || mode === 'observe-only') {
        if (mode === 'dry-run' && this.dryRunController) {
          this.dryRunController.start(this.state.sessionId ?? 'dry-run');
        }
        await this.navigateToGame();
        await this.initializeObservation();
        this.startHealthMonitoring();
        this.setPhase('observing');
        this.state.observing = true;
        this.logger.info({ mode, loginStatus: this.state.loginStatus }, 'Observing (auth optional)');
      } else {
        if (this.state.authenticated) {
          await this.navigateToGame();
          await this.initializeObservation();
          this.startHealthMonitoring();
          this.setPhase('observing');
          this.state.observing = true;
          this.logger.info({ mode }, 'Restored authenticated session — observing');
        } else {
          this.setPhase('auth-required');
          this.state.loginStatus = 'AUTH_FAILED';
          this.logger.warn({ mode }, 'Live mode requires /login — browser launched, waiting for credentials');
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.lastError = message;
      this.state.errorCount += 1;
      this.state.consecutiveErrors += 1;
      this.setPhase(/BROWSER|chromium|playwright/i.test(message) ? 'browser-failed' : 'error', message);
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.setPhase('stopped');
    this.state.observing = false;
    this.stopHealthMonitoring();
    this.detachObserverListeners();
    try { await this.roundObserver?.stop(); } catch { /* ignore */ }
    try { await this.gameAdapter?.stop(); } catch { /* ignore */ }
    this.roundObserver = null;
    this.gameAdapter = null;
    try {
      if (this.browserManager) {
        this.browserManager.setRecoveryEnabled(false);
        await this.browserManager.close();
      }
    } catch { /* ignore */ }
    this.browserManager = null;
    this.state.browserLaunched = false;
    this.logger.info('SessionSupervisor stopped');
  }

  async pause(): Promise<void> {
    this.setPhase('paused');
    this.state.observing = false;
    this.detachObserverListeners();
    try { await this.roundObserver?.stop(); } catch { /* ignore */ }
  }

  async resume(): Promise<void> {
    if (this.state.phase !== 'paused') return;
    await this.initializeObservation();
    this.setPhase('observing');
    this.state.observing = true;
  }

  setSignalEvaluator(fn: ((roundId: string) => void | Promise<void>) | null): void {
    this.signalEvaluator = fn;
  }

  setDryRunController(ctrl: DryRunController | null): void {
    this.dryRunController = ctrl;
  }

  async loginWithCredentials(email: string, password: string): Promise<LoginOutcome> {
    const masked = maskEmail(email);
    this.state.loginStatus = 'TESTING';
    const mode = String(this.options.config.system.mode ?? 'dry-run').toLowerCase();
    const wasObserving = this.state.observing;

    if (!this.state.browserLaunched) {
      const preflight = await runNetworkPreflight(
        process.env.BC_GAME_LOGIN_URL?.trim() || BC_GAME_URLS.login
      );
      if (!preflight.ok) {
        this.setPhase('preflight-failed', 'network preflight failed');
        this.state.loginStatus = 'AUTH_FAILED';
        return {
          ok: false,
          authenticated: false,
          detail: `PREFLIGHT_FAILED: ${preflight.checks
            .filter((c) => !c.ok)
            .map((c) => `${c.name}=${c.detail ?? 'fail'}`)
            .join('; ')}`,
          code: 'PREFLIGHT_FAILED',
          maskedEmail: masked,
        };
      }
    }

    try {
      if (!this.browserManager || !this.state.browserLaunched) {
        await this.initializeProfile();
        await this.launchBrowser();
        await this.restoreSessionState();
      }

      const page = this.browserManager?.getPage();
      if (!page) {
        this.state.loginStatus = 'AUTH_FAILED';
        this.setPhase('browser-failed', 'no page');
        return {
          ok: false,
          authenticated: false,
          detail: 'BROWSER_NOT_READY',
          code: 'BROWSER_FAILED',
          maskedEmail: masked,
        };
      }

      this.setPhase('authenticating');

      const report = await runLoginTestPipeline(page, {
        loginUrl: process.env.BC_GAME_LOGIN_URL?.trim() || BC_GAME_URLS.login,
        email,
        password,
        browserSession: this.browserSession,
        context: this.browserManager?.getContext() ?? null,
        sessionLabel: this.state.authenticated ? 'restored' : 'new',
      });
      password = '';

      this.state.lastLoginReport = report;
      this.state.loginStatus = report.status;

      if (report.regionBlocked || report.status === 'REGION_BLOCKED') {
        this.state.authenticated = false;
        this.setPhase('region-blocked', report.classification);
        return {
          ok: false,
          authenticated: false,
          regionBlocked: true,
          detail: report.classification || 'REGION_BLOCKED',
          code: 'REGION_BLOCKED',
          maskedEmail: masked,
          loginReport: report,
          observing: this.state.observing,
        };
      }

      if (report.status !== 'AUTHENTICATED') {
        this.state.authenticated = false;
        if (!(mode === 'dry-run' && wasObserving)) {
          this.setPhase('auth-required', report.classification);
        }
        return {
          ok: false,
          authenticated: false,
          detail: report.classification,
          code: report.classification,
          maskedEmail: masked,
          loginReport: report,
          observing: this.state.observing,
          pageState: report.classification,
        };
      }

      this.state.authenticated = true;
      this.state.loginStatus = 'AUTHENTICATED';
      this.state.consecutiveErrors = 0;

      try {
        const ctx = this.browserManager?.getContext();
        if (ctx && this.browserSession) {
          await this.browserSession.captureAndSave(ctx);
        }
      } catch (err) {
        this.logger.warn({ error: String(err) }, 'Post-login session capture failed (non-fatal)');
      }

      if (!this.state.observing) {
        try {
          await this.navigateToGame();
          await this.initializeObservation();
          this.startHealthMonitoring();
          this.setPhase('observing');
          this.state.observing = true;
        } catch (err) {
          this.logger.warn({ error: String(err) }, 'Post-login navigate/observe failed');
          this.state.lastError = err instanceof Error ? err.message : String(err);
        }
      } else {
        try { await this.navigateToGame(); } catch { /* ignore */ }
      }

      this.logger.info(
        { maskedEmail: masked, gameLoaded: this.state.gameLoaded, observing: this.state.observing },
        'Login succeeded — session persisted, browser kept alive'
      );

      return {
        ok: true,
        authenticated: true,
        gameLoaded: this.state.gameLoaded,
        observing: this.state.observing,
        maskedEmail: masked,
        loginReport: report,
        pageState: 'AUTHENTICATED',
      };
    } catch (err) {
      password = '';
      const message = err instanceof Error ? err.message : String(err);
      this.state.loginStatus = 'AUTH_FAILED';
      this.state.lastError = message;
      this.state.errorCount += 1;
      this.state.consecutiveErrors += 1;
      this.logger.error({ error: message, maskedEmail: masked }, 'loginWithCredentials failed');
      return {
        ok: false,
        authenticated: false,
        detail: message,
        code: 'LOGIN_ERROR',
        maskedEmail: masked,
        observing: this.state.observing,
      };
    }
  }

  getState(): Readonly<SupervisorState> {
    return { ...this.state };
  }

  getPhase(): SupervisorPhase {
    return this.state.phase;
  }

  isObserving(): boolean {
    return this.state.observing && this.state.phase === 'observing';
  }

  isAuthenticated(): boolean {
    return this.state.authenticated;
  }

  getLoginStatus(): LoginStatus {
    return this.state.loginStatus;
  }

  getLastLoginReport(): LoginTestReport | null {
    return this.state.lastLoginReport;
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

  getDryRunController(): DryRunController | null {
    return this.dryRunController;
  }

  onPhaseChange(
    listener: (ev: {
      previous: SupervisorPhase;
      current: SupervisorPhase;
      detail?: string;
      at: string;
    }) => void
  ): () => void {
    this.phaseEmitter.on('phase:changed', listener);
    return () => this.phaseEmitter.off('phase:changed', listener);
  }

  private setPhase(phase: SupervisorPhase, detail?: string): void {
    const previous = this.state.phase;
    this.state.phase = phase;
    this.logger.info({ previousPhase: previous, newPhase: phase, detail }, 'Session phase transition');
    this.phaseEmitter.emit('phase:changed', {
      previous,
      current: phase,
      detail,
      at: new Date().toISOString(),
    });
  }

  private async initializeProfile(): Promise<void> {
    const profileDir = this.options.config.browser.profileDirectory;
    const baseDir =
      process.env.BROWSER_PROFILE_DIR ||
      path.dirname(profileDir) ||
      path.join(process.cwd(), 'secrets');
    this.profileManager = new ProfileManager({ baseDirectory: baseDir });
    try {
      await this.profileManager.initialize();
    } catch (err) {
      this.logger.warn({ error: String(err) }, 'ProfileManager.initialize failed (continuing)');
    }
    this.browserSession = new BrowserSession({ profileDirectory: profileDir });
    if (!this.state.sessionId) {
      this.state.sessionId = this.options.sessionId ?? `sess-${Date.now().toString(36)}`;
    }
  }

  private async launchBrowser(): Promise<void> {
    this.setPhase('launching-browser');
    const launchOptions = toLaunchOptions(
      this.options.config.browser,
      this.options.config.proxy,
      this.options.config.system.mode
    );
    launchOptions.userDataDir = this.options.config.browser.profileDirectory;
    this.browserManager = new BrowserManager(launchOptions);
    await this.browserManager.launch();
    this.state.browserLaunched = true;
    this.logger.info({ headless: launchOptions.headless }, 'Browser launched');
  }

  private async restoreSessionState(): Promise<void> {
    this.setPhase('restoring-session');
    const ctx = this.browserManager?.getContext();
    if (ctx && this.browserSession) {
      const restored = await this.browserSession.restoreIfAvailable(ctx);
      this.logger.info({ restored }, 'Session restore attempt finished');
      if (restored) {
        try {
          await this.browserSession.captureAndSave(ctx);
          this.logger.info('Refreshed session state persisted after restore');
        } catch (err) {
          this.logger.warn({ error: String(err) }, 'Post-restore session capture failed (non-fatal)');
        }
      }
    }
  }

  private async refreshAuthStatusFromPage(): Promise<void> {
    const page = this.browserManager?.getPage();
    if (!page || !this.browserSession) return;
    try {
      const result = await this.browserSession.checkAuthentication(page);
      if (result.regionBlocked) {
        this.state.authenticated = false;
        this.state.loginStatus = 'REGION_BLOCKED';
        this.setPhase('region-blocked', result.detail);
        return;
      }
      if (result.authenticated) {
        this.state.authenticated = true;
        this.state.loginStatus = 'AUTHENTICATED';
      }
    } catch (err) {
      this.logger.debug({ error: String(err) }, 'refreshAuthStatusFromPage failed');
    }
  }

  private async navigateToGame(): Promise<void> {
    this.setPhase('navigating');
    if (!this.browserManager) {
      throw new CriticalError('Browser not launched', 'BROWSER_NOT_LAUNCHED');
    }
    const gameUrl = process.env.BC_GAME_CRASH_URL?.trim() || BC_GAME_URLS.crash;
    const nav = await this.browserManager.navigate(gameUrl, 'domcontentloaded');
    if (!nav.success) {
      this.logger.warn({ error: nav.error, url: gameUrl }, 'Navigate to Crash returned non-success');
    }
    this.state.gameLoaded = true;
    this.setPhase('loading-game');
  }

  private async initializeObservation(): Promise<void> {
    const page = this.browserManager?.getPage();
    if (!page) {
      throw new CriticalError('No page for observation', 'BROWSER_NOT_LAUNCHED');
    }

    this.detachObserverListeners();
    try { await this.roundObserver?.stop(); } catch { /* ignore */ }
    try { await this.gameAdapter?.stop(); } catch { /* ignore */ }

    this.gameAdapter = new GameAdapter({
      page,
      enableDomAdapter: true,
      enableWsAdapter: true,
      enableApiAdapter: false,
      pollIntervalMs: 100,
    });
    this.roundObserver = new RoundObserver({
      adapter: this.gameAdapter,
      minConfidenceForEntry: this.options.config.observation.minConfidenceForEntry,
      maxLatencyMs: this.options.config.observation.maxTickLatencyMs,
    });

    await this.gameAdapter.start();
    await this.roundObserver.start();

    this.unsubRoundStart = this.roundObserver.onRoundStart((roundId) => {
      const sid = this.state.sessionId ?? 'unknown';
      void this.options.eventBus
        .emit(
          createEvent(
            'RoundStarted',
            {
              roundId,
              sessionId: sid,
              startedAt: new Date().toISOString(),
            },
            { correlationId: roundId, source: 'SessionSupervisor' }
          )
        )
        .catch(() => undefined);
      void this.signalEvaluator?.(roundId);
    });

    this.unsubRoundComplete = this.roundObserver.onRoundComplete((roundId, crashPoint) => {
      this.dryRunController?.onRoundCompleted(roundId, crashPoint);
      void this.options.eventBus
        .emit(
          createEvent(
            'RoundCrashed',
            {
              roundId,
              crashPoint,
              crashedAt: new Date().toISOString(),
            },
            { correlationId: roundId, source: 'SessionSupervisor' }
          )
        )
        .catch(() => undefined);
    });

    this.state.observing = true;
    this.logger.info(
      { dryRun: !!this.dryRunController, sessionId: this.state.sessionId },
      'Observation initialized — RoundStarted/RoundCrashed wired to EventBus'
    );
  }

  private detachObserverListeners(): void {
    try { this.unsubRoundStart?.(); } catch { /* ignore */ }
    try { this.unsubRoundComplete?.(); } catch { /* ignore */ }
    this.unsubRoundStart = null;
    this.unsubRoundComplete = null;
  }

  private startHealthMonitoring(): void {
    this.stopHealthMonitoring();
    this.healthMonitor = new BrowserHealthMonitor({
      frozenThresholdMs: 5000,
      memoryThresholdMB: 512,
      tickTimeoutMs: 3000,
    });
    const page = this.browserManager?.getPage();
    if (page) {
      this.healthMonitor.start(page, 5000);
    }
  }

  private stopHealthMonitoring(): void {
    try { this.healthMonitor?.stop(); } catch { /* ignore */ }
    this.healthMonitor = null;
  }
}
