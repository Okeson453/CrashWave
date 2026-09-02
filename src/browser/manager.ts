import { chromium, BrowserContext, Page } from 'playwright';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import {
  BrowserLaunchOptions,
  BrowserManagerState,
  NavigationResult,
  BrowserLifecyclePhase,
} from './types';
import { getLogger } from '../observability/logger';
import { CriticalError } from '../utils/errors';
import { withRetry } from '../utils/retry';
import { FingerprintProfile, loadOrCreateFingerprint, fingerprintToContextOptions, newProfileId } from './fingerprint';
import { stealthLaunchArgs, applyStealthToContext, applyStealthToPage } from './stealth';
import { buildHardenedLaunchArgs } from './evasion/launch-config.js';
import { ProxyManager } from '../network/proxy-manager';
import { robustNavigate } from './navigation';

export class BrowserManager {
  private browser: BrowserContext | null = null;
  private page: Page | null = null;
  private state: BrowserManagerState;
  private readonly logger = getLogger();
  private readonly options: BrowserLaunchOptions;
  private fingerprint: FingerprintProfile | null = null;
  private lifecycleListeners: Array<(event: { phase: BrowserLifecyclePhase; detail?: string; error?: string }) => void> = [];
  private recoveryAttempts = 0;
  private readonly maxRecoveryAttempts = 5;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryEnabled = true;

  constructor(options: BrowserLaunchOptions) {
    this.options = options;
    this.state = {
      launched: false,
      pageUrl: null,
      authenticated: false,
      gameLoaded: false,
      profileId: null,
      launchedAt: null,
    };
  }

  onLifecycle(callback: (event: { phase: BrowserLifecyclePhase; detail?: string; error?: string }) => void): () => void {
    this.lifecycleListeners.push(callback);
    return () => {
      const idx = this.lifecycleListeners.indexOf(callback);
      if (idx >= 0) this.lifecycleListeners.splice(idx, 1);
    };
  }

  private emitLifecycle(phase: BrowserLifecyclePhase, detail?: string, error?: string): void {
    const event = { phase, detail, error };
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.warn({ component: 'BrowserManager', error: String(err) }, 'Lifecycle listener error');
      }
    }
  }

  async launch(): Promise<Page> {
    if (this.browser && this.page) {
      this.logger.debug({ component: 'BrowserManager' }, 'Browser already launched, reusing');
      return this.page;
    }

    this.emitLifecycle('launching');
    this.logger.info({ component: 'BrowserManager', headless: this.options.headless }, 'Launching browser');

    try {
      if (!existsSync(this.options.userDataDir)) {
        await mkdir(this.options.userDataDir, { recursive: true });
      }

      const profileId = this.state.profileId ?? newProfileId();
      this.state.profileId = profileId;
      const fp = loadOrCreateFingerprint(profileId, this.options.userDataDir, {
        viewport: this.options.viewport,
        timezoneId: (this.options as { timezoneId?: string }).timezoneId ?? 'UTC',
        locale: (this.options as { locale?: string }).locale ?? 'en-US',
        proxyGeo: (this.options as { proxyGeo?: string | null }).proxyGeo ?? null,
      });
      this.fingerprint = fp;
      const fpOpts = fingerprintToContextOptions(fp);
      const stealthEnabled = this.options.stealth !== false;
      const stealthArgs = stealthEnabled
        ? buildHardenedLaunchArgs({
            headless: this.options.headless,
            windowWidth: this.options.viewport?.width,
            windowHeight: this.options.viewport?.height,
            useRealGpu: process.env.STEALTH_REAL_GPU === '1',
            extraArgs: this.options.args,
          })
        : stealthLaunchArgs(true);
      // Do not stack STEALTH_BROWSER_ARGS again — hardened/stealth builder already owns the flag set.
      const args = [...new Set([...stealthArgs, ...(this.options.args ?? [])])].filter(
        (a) => !String(a).includes('enable-automation')
      );

      let playwrightProxy = (this.options as { proxy?: { server: string; username?: string; password?: string } }).proxy;
      const proxyConfig = (this.options as { proxyConfig?: import('../config/schema').ProxyConfig }).proxyConfig;
      if (!playwrightProxy && proxyConfig?.enabled) {
        const pm = new ProxyManager();
        void proxyConfig; // config loaded on demand
        const resolved = await pm.resolve();
        if (resolved) {
          playwrightProxy = {
            server: resolved.server,
            username: resolved.username,
            password: resolved.password,
          };
        }
      }

      this.browser = await withRetry(
        () =>
          chromium.launchPersistentContext(this.options.userDataDir, {
            headless: this.options.headless,
            viewport: fpOpts.viewport,
            userAgent: fpOpts.userAgent,
            locale: fpOpts.locale,
            timezoneId: fpOpts.timezoneId,
            deviceScaleFactor: fpOpts.deviceScaleFactor,
            extraHTTPHeaders: fpOpts.extraHTTPHeaders,
            args,
            timeout: this.options.timeoutMs,
            bypassCSP: true,
            ignoreHTTPSErrors: true,
            proxy: playwrightProxy,
          }),
        {
          maxRetries: 3,
          baseDelayMs: 1000,
          retryableErrors: ['ECONNREFUSED', 'TimeoutError', 'browser has been closed'],
        }
      );

      const pages = this.browser.pages();
      this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

      if (stealthEnabled && this.browser && this.fingerprint) {
        try {
          await applyStealthToContext(this.browser, this.fingerprint);
          if (this.page) {
            await applyStealthToPage(this.page, this.fingerprint);
          }
        } catch (err) {
          this.logger.warn(
            { component: 'BrowserManager', error: String(err) },
            'Stealth application failed (non-fatal)'
          );
        }
      }

      this.page!.setDefaultTimeout(this.options.timeoutMs);
      this.page!.setDefaultNavigationTimeout(this.options.timeoutMs);

      this.page!.on('pageerror', (err: Error) => {
        this.logger.warn({ component: 'BrowserManager', error: err.message }, 'Page JavaScript error');
      });

      this.page!.on('crash', () => {
        this.logger.error({ component: 'BrowserManager' }, 'Page crashed');
        this.state.launched = false;
        this.emitLifecycle('error', undefined, 'Page crashed');
        void this.scheduleRecovery();
      });

      this.page!.on('close', () => {
        this.logger.warn({ component: 'BrowserManager' }, 'Page closed unexpectedly');
        this.state.launched = false;
        this.page = null;
        void this.scheduleRecovery();
      });

      this.state.launched = true;
      this.state.launchedAt = new Date().toISOString();
      this.emitLifecycle('launched', `Viewport: ${this.options.viewport.width}x${this.options.viewport.height}`);

      this.logger.info({ component: 'BrowserManager' }, 'Browser launched successfully');
      return this.page;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BrowserManager', error: message }, 'Failed to launch browser');
      this.emitLifecycle('error', undefined, message);
      const missingBrowser =
        /executable doesn't exist/i.test(message) || /executable does not exist/i.test(message);
      const displayMissing =
        /Missing X server/i.test(message) ||
        /\$DISPLAY/i.test(message) ||
        /without having a XServer/i.test(message) ||
        /ozone_platform_x11/i.test(message) ||
        /Target page, context or browser has been closed/i.test(message);
      let detail: string;
      if (displayMissing) {
        detail =
          `BROWSER_LAUNCH_FAILED: Chromium needs a display but none is available (${message}). ` +
          'In Docker set browser.headless=true (or BROWSER_HEADLESS=1). Do not use headed mode without Xvfb.';
      } else if (missingBrowser) {
        detail =
          `BROWSER_LAUNCH_FAILED: Playwright/Chromium missing or version mismatch (${message}). ` +
          'Pin package playwright and Docker image mcr.microsoft.com/playwright to the same version (1.62.1).';
      } else {
        detail = `Browser launch failed: ${message}`;
      }
      throw new CriticalError(detail, 'BROWSER_LAUNCH_FAILED');
    }
  }

  async navigate(url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'networkidle'): Promise<NavigationResult> {
    if (!this.page) {
      throw new CriticalError('Browser not launched', 'BROWSER_NOT_LAUNCHED');
    }

    this.emitLifecycle('navigating', `URL: ${url}`);
    const timeoutMs = Math.max(this.options.timeoutMs ?? 45_000, 60_000);

    const diag = await robustNavigate(this.page, url, {
      timeoutMs,
      retries: 2,
      waitUntil,
    });

    this.state.pageUrl = diag.finalUrl || this.page.url();

    if (diag.navigationStatus === 'ok') {
      this.logger.info(
        {
          component: 'BrowserManager',
          requestedUrl: diag.requestedUrl,
          finalUrl: diag.finalUrl,
          pageTitle: diag.pageTitle,
          loadTimeMs: diag.loadTimeMs,
          attempts: diag.attempts,
        },
        'Navigation complete'
      );
      return {
        success: true,
        url: diag.finalUrl,
        title: diag.pageTitle,
        loadTimeMs: diag.loadTimeMs,
      };
    }

    this.logger.error(
      {
        component: 'BrowserManager',
        requestedUrl: diag.requestedUrl,
        finalUrl: diag.finalUrl,
        pageTitle: diag.pageTitle,
        navigationError: diag.navigationError,
        preflight: diag.preflight,
        attempts: diag.attempts,
      },
      'Navigation failed'
    );
    return {
      success: false,
      url: diag.finalUrl || this.page.url(),
      title: diag.pageTitle,
      loadTimeMs: diag.loadTimeMs,
      error: diag.navigationError || 'NAVIGATION_FAILED',
    };
  }

  async reload(waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'networkidle'): Promise<NavigationResult> {
    if (!this.page) {
      throw new CriticalError('Browser not launched', 'BROWSER_NOT_LAUNCHED');
    }

    const startTime = Date.now();
    try {
      await this.page.reload({ waitUntil, timeout: this.options.timeoutMs });
      const loadTimeMs = Date.now() - startTime;
      return {
        success: true,
        url: this.page.url(),
        title: await this.page.title(),
        loadTimeMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        url: this.page?.url() || '',
        title: '',
        loadTimeMs: Date.now() - startTime,
        error: message,
      };
    }
  }

  getFingerprint(): FingerprintProfile | null {
    return this.fingerprint;
  }

  getPage(): Page {
    if (!this.page) {
      throw new CriticalError('Browser page not available', 'PAGE_NOT_AVAILABLE');
    }
    return this.page;
  }

  getContext(): BrowserContext {
    if (!this.browser) {
      throw new CriticalError('Browser context not available', 'CONTEXT_NOT_AVAILABLE');
    }
    return this.browser;
  }

  isLaunched(): boolean {
    return this.state.launched && this.browser !== null && this.page !== null;
  }

  getState(): Readonly<BrowserManagerState> {
    return { ...this.state };
  }

  async takeScreenshot(path?: string): Promise<Buffer> {
    if (!this.page) {
      throw new CriticalError('Browser not launched', 'BROWSER_NOT_LAUNCHED');
    }
    return this.page.screenshot({ path, fullPage: false });
  }

  async getCurrentUrl(): Promise<string> {
    if (!this.page) return '';
    return this.page.url();
  }

  async getPageTitle(): Promise<string> {
    if (!this.page) return '';
    return this.page.title();
  }

  async evaluate<T>(pageFunction: string | ((...args: unknown[]) => T | Promise<T>), arg?: unknown): Promise<T> {
    if (!this.page) {
      throw new CriticalError('Browser not launched', 'BROWSER_NOT_LAUNCHED');
    }
    return this.page.evaluate(pageFunction as never, arg);
  }

  async close(): Promise<void> {
    this.setRecoveryEnabled(false);
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    this.emitLifecycle('closing');
    this.logger.info({ component: 'BrowserManager' }, 'Closing browser');

    try {
      if (this.page) {
        try {
          await this.page.close();
        } catch {
          // Ignore close errors
        }
        this.page = null;
      }

      if (this.browser) {
        try {
          await this.browser.close();
        } catch {
          // Ignore close errors
        }
        this.browser = null;
      }

      this.state.launched = false;
      this.state.pageUrl = null;
      this.state.authenticated = false;
      this.state.gameLoaded = false;
      this.state.launchedAt = null;

      this.emitLifecycle('closed');
      this.logger.info({ component: 'BrowserManager' }, 'Browser closed');
      this.setRecoveryEnabled(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BrowserManager', error: message }, 'Error during browser close');
      this.emitLifecycle('error', undefined, message);
    }
  }


  /** Disable auto-recovery (e.g. during intentional shutdown). */
  setRecoveryEnabled(enabled: boolean): void {
    this.recoveryEnabled = enabled;
    if (!enabled && this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private async scheduleRecovery(): Promise<void> {
    if (!this.recoveryEnabled) return;
    if (this.recoveryTimer) return; // already scheduled
    if (this.recoveryAttempts >= this.maxRecoveryAttempts) {
      this.logger.error(
        { component: 'BrowserManager', attempts: this.recoveryAttempts },
        'Max browser recovery attempts exceeded — giving up, manual intervention required'
      );
      this.emitLifecycle('error', undefined, 'Recovery exhausted — manual restart required');
      return;
    }
    const backoffMs = Math.min(5_000 * 2 ** this.recoveryAttempts, 120_000);
    this.recoveryAttempts += 1;
    this.logger.warn(
      { component: 'BrowserManager', attempt: this.recoveryAttempts, backoffMs },
      'Scheduling browser recovery'
    );
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.relaunch().then(
        () => {
          this.recoveryAttempts = 0;
          this.logger.info({ component: 'BrowserManager' }, 'Browser recovered successfully');
        },
        (err) => {
          this.logger.error(
            { component: 'BrowserManager', error: String(err) },
            'Recovery attempt failed'
          );
          void this.scheduleRecovery();
        }
      );
    }, backoffMs);
  }

  /** Close any half-open browser and relaunch using the same options. */
  async relaunch(): Promise<Page> {
    this.setRecoveryEnabled(false);
    try {
      await this.close();
    } catch {
      /* ignore */
    } finally {
      this.setRecoveryEnabled(true);
    }
    return this.launch();
  }

  async forceKill(): Promise<void> {
    this.logger.warn({ component: 'BrowserManager' }, 'Force killing browser process');
    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch {
      // Ignore
    } finally {
      this.browser = null;
      this.page = null;
      this.state.launched = false;
      this.emitLifecycle('closed', 'Force killed');
    }
  }
}

let globalManager: BrowserManager | null = null;

export function createBrowserManager(options: BrowserLaunchOptions): BrowserManager {
  globalManager = new BrowserManager(options);
  return globalManager;
}

export function getBrowserManager(): BrowserManager {
  if (!globalManager) {
    throw new Error('BrowserManager not initialized. Call createBrowserManager() first.');
  }
  return globalManager;
}

export function setBrowserManager(manager: BrowserManager): void {
  globalManager = manager;
}
