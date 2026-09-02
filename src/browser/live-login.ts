/**
 * LiveLoginService — one-shot browser login for the personal-use runtime.
 *
 * Triggered by the /login Telegram command. Spins up a headless Chromium,
 * navigates to BC.Game, submits the operator's credentials via
 * submitBcGameLogin (humanized input), captures the resulting
 * authenticated context's cookies + storage, encrypts them with
 * ENCRYPTION_KEY, and persists to <profileDirectory>/session-state.enc.
 *
 * The password is held in a local variable, used once for the
 * submitBcGameLogin call, and then immediately discarded by letting
 * it go out of scope. It is never logged, written to disk, sent to
 * the DB, or stored in the encrypted session blob (only cookies,
 * localStorage, and sessionStorage are persisted).
 *
 * The browser context is closed on exit (success or failure) so the
 * process does not leak Chromium instances between /login invocations.
 *
 * Idempotency: if a previous session-state.enc exists and the resulting
 * storageState still authenticates, the operator is told "ALREADY
 * AUTHENTICATED" without re-prompting for credentials. The flow is
 * still safe to call repeatedly.
 */
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { chromium, BrowserContext, Page } from 'playwright';
import { getLogger } from '../observability/logger';
import { submitBcGameLogin, classifyLoginPage, BcGameLoginResult } from './bc-game-login';
import { BrowserSession } from './session';
import { runNetworkPreflight } from './preflight';
import { BrowserLaunchOptions } from './types';
import { loadAndValidateConfig } from '../config/loader';

const logger = getLogger().child({ component: 'LiveLogin' });

export interface LiveLoginOptions {
  /** Override profile directory; defaults to config.browser.profileDirectory */
  profileDirectory?: string;
  /** Force headed mode for debugging (default: config.browser.headless) */
  headless?: boolean;
  /** Optional override for the login URL */
  loginUrl?: string;
}

export interface LiveLoginOutcome {
  ok: boolean;
  authenticated: boolean;
  regionBlocked?: boolean;
  gameLoaded?: boolean;
  observing?: boolean;
  detail?: string;
  pageState?: string;
  maskedEmail?: string;
  preflight?: { ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> };
}

/**
 * Mask the local-part of an email for safe logging:
 *   okesonsystem@gmail.com -> o*********m@gmail.com
 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0] ?? '*'}*${domain}`;
  return `${local[0]}${'*'.repeat(Math.max(local.length - 2, 1))}${local[local.length - 1]}${domain}`;
}

/**
 * Build the BrowserLaunchOptions we need for a one-shot login.
 * Kept minimal — login only needs the headless flag, viewport,
 * profile directory, and a generous timeout.
 */
function buildLaunchOptions(profileDirectory: string, headless: boolean): BrowserLaunchOptions {
  return {
    headless,
    userDataDir: profileDirectory,
    timeoutMs: 60_000,
    viewport: { width: 1366, height: 900 },
    stealth: true,
  };
}

export class LiveLoginService {
  private readonly profileDirectory: string;
  private readonly headless: boolean;
  private inFlight: Promise<LiveLoginOutcome> | null = null;

  constructor(opts: LiveLoginOptions = {}) {
    let cfg: ReturnType<typeof loadAndValidateConfig> | null = null;
    try {
      cfg = loadAndValidateConfig();
    } catch {
      // Config loader is optional in some test contexts.
    }
    const fallbackDir = cfg?.browser?.profileDirectory ?? './secrets/browser-profile';
    this.profileDirectory = opts.profileDirectory ?? fallbackDir;
    this.headless = opts.headless ?? cfg?.browser?.headless ?? true;
  }

  /**
   * Public entry — perform a one-shot login. Concurrent calls share the
   * same in-flight promise so the operator cannot accidentally launch
   * two browsers in parallel by double-typing.
   */
  login(email: string, password: string, loginUrl?: string): Promise<LiveLoginOutcome> {
    if (this.inFlight) {
      logger.warn({ component: 'LiveLogin' }, 'Login already in flight, returning existing promise');
      return this.inFlight;
    }
    this.inFlight = this.runLogin(email, password, loginUrl).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runLogin(
    email: string,
    password: string,
    loginUrl?: string
  ): Promise<LiveLoginOutcome> {
    if (!existsSync(this.profileDirectory)) {
      await mkdir(this.profileDirectory, { recursive: true });
    }

    // Cheap network preflight — refuse to launch Chromium if bc.game is
    // unreachable from this network. Saves ~10s of futile browser boot.
    const preflight = await runNetworkPreflight(loginUrl ?? 'https://bc.game/');
    if (!preflight.ok) {
      logger.warn(
        { component: 'LiveLogin', failedChecks: preflight.checks.filter((c) => !c.ok) },
        'Network preflight failed; aborting login before browser launch'
      );
      return {
        ok: false,
        authenticated: false,
        detail: `PREFLIGHT_FAILED: ${preflight.checks
          .filter((c) => !c.ok)
          .map((c) => `${c.name}=${c.detail ?? 'fail'}`)
          .join('; ')}`,
        preflight,
        maskedEmail: maskEmail(email),
      };
    }

    const opts = buildLaunchOptions(this.profileDirectory, this.headless);
    let context: BrowserContext | null = null;
    let result: BcGameLoginResult | null = null;

    try {
      // Use launchPersistentContext so the user-data-dir session is
      // available across restarts (cookies + localStorage persist).
      context = await chromium.launchPersistentContext(opts.userDataDir, {
        headless: opts.headless,
        viewport: opts.viewport,
        timeout: opts.timeoutMs,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        bypassCSP: true,
        ignoreHTTPSErrors: true,
      });
      const page: Page = context.pages()[0] ?? (await context.newPage());

      result = await submitBcGameLogin(page, email, password, {
        loginUrl,
        timeoutMs: 60_000,
      });

      if (result.ok && result.authenticated) {
        // Persist the authenticated session to disk (encrypted).
        try {
          const session = new BrowserSession({ profileDirectory: this.profileDirectory });
          await session.capture(context);
          logger.info(
            { component: 'LiveLogin', maskedEmail: maskEmail(email), pageState: result.pageState },
            'BC.Game session captured and persisted'
          );
        } catch (err) {
          logger.error(
            { component: 'LiveLogin', error: err instanceof Error ? err.message : String(err) },
            'Failed to persist BC.Game session'
          );
          // Login itself succeeded; just report that persistence failed.
          result = {
            ...result,
            ok: false,
            detail: `${result.detail ?? 'AUTH_OK'} + SESSION_PERSIST_FAILED`,
          };
        }
      }

      return {
        ok: result.ok,
        authenticated: result.authenticated,
        regionBlocked: result.regionBlocked,
        gameLoaded: result.authenticated, // heuristic: authenticated ⇒ game loaded
        observing: result.authenticated, // personal-use auto-observes after login
        detail: result.detail,
        pageState: result.pageState,
        maskedEmail: maskEmail(email),
        preflight,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ component: 'LiveLogin', error: message }, 'Live login flow threw');
      return {
        ok: false,
        authenticated: false,
        detail: `LOGIN_FLOW_ERROR: ${message}`.slice(0, 600),
        maskedEmail: maskEmail(email),
        preflight,
      };
    } finally {
      // Always close the context — login is a one-shot, not a long-running bot.
      if (context) {
        try {
          await context.close();
        } catch (err) {
          logger.warn(
            { component: 'LiveLogin', error: err instanceof Error ? err.message : String(err) },
            'Failed to close browser context cleanly'
          );
        }
      }
    }
  }

  /**
   * Quick re-check whether an already-persisted session is still valid
   * without prompting the operator for credentials. Used by /login to
   * short-circuit when the user is already authenticated.
   */
  async checkExistingSession(): Promise<{ exists: boolean; authenticated: boolean; detail?: string }> {
    const sessionFile = join(this.profileDirectory, 'session-state.enc');
    if (!existsSync(sessionFile)) {
      return { exists: false, authenticated: false, detail: 'NO_PERSISTED_SESSION' };
    }

    let context: BrowserContext | null = null;
    try {
      const opts = buildLaunchOptions(this.profileDirectory, this.headless);
      context = await chromium.launchPersistentContext(opts.userDataDir, {
        headless: opts.headless,
        viewport: opts.viewport,
        timeout: opts.timeoutMs,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        bypassCSP: true,
        ignoreHTTPSErrors: true,
      });
      const page: Page = context.pages()[0] ?? (await context.newPage());
      await page.goto('https://bc.game/crash', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      const cls = await classifyLoginPage(page, page.url());
      return {
        exists: true,
        authenticated: cls.detectedPageState === 'AUTHENTICATED',
        detail: cls.detectedPageState,
      };
    } catch (err) {
      return {
        exists: true,
        authenticated: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (context) {
        try {
          await context.close();
        } catch {
          /* ignore */
        }
      }
    }
  }
}
