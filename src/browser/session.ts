import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { BrowserContext, Page } from 'playwright';
import {
  BrowserSessionState,
  EncryptedSessionState,
  AuthCheckResult,
} from './types';
import { encryptJSON, decryptJSON } from '../security/crypto';
import { getLogger } from '../observability/logger';
import { CriticalError, TransientError } from '../utils/errors';

const SESSION_FILE = 'session-state.enc';
const SESSION_VERSION = 1;

export interface SessionStoreOptions {
  profileDirectory: string;
  sessionFileName?: string;
}

export class BrowserSession {
  private readonly options: SessionStoreOptions;
  private readonly sessionFilePath: string;
  private readonly logger = getLogger();
  private currentState: BrowserSessionState | null = null;

  constructor(options: SessionStoreOptions) {
    this.options = {
      sessionFileName: SESSION_FILE,
      ...options,
    };
    this.sessionFilePath = join(this.options.profileDirectory, this.options.sessionFileName!);
  }

  /**
   * Capture the current browser session state (cookies, storage) from the context.
   */
  async capture(context: BrowserContext): Promise<BrowserSessionState> {
    this.logger.debug({ component: 'BrowserSession' }, 'Capturing session state');

    try {
      const storageState = await context.storageState();

      const state: BrowserSessionState = {
        cookies: storageState.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: (c.sameSite as 'Strict' | 'Lax' | 'None') || 'Lax',
        })),
        origins: storageState.origins.map((o) => ({
          origin: o.origin,
          localStorage: o.localStorage.map((item) => ({
            name: item.name,
            value: item.value,
          })),
          sessionStorage: [], // Playwright storageState doesn't include sessionStorage
        })),
        timestamp: new Date().toISOString(),
        version: SESSION_VERSION,
      };

      this.currentState = state;
      this.logger.info(
        { component: 'BrowserSession', cookieCount: state.cookies.length, originCount: state.origins.length },
        'Session state captured'
      );

      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BrowserSession', error: message }, 'Failed to capture session state');
      throw new TransientError(`Session capture failed: ${message}`, 'SESSION_CAPTURE_FAILED');
    }
  }

  /**
   * Save the captured session state to an encrypted file.
   */
  async save(state?: BrowserSessionState): Promise<void> {
    const data = state || this.currentState;
    if (!data) {
      throw new CriticalError('No session state to save', 'NO_SESSION_STATE');
    }

    try {
      // Ensure directory exists
      const dir = this.options.profileDirectory;
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      const encrypted = encryptJSON(data);
      const payload: EncryptedSessionState = {
        encrypted: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        timestamp: data.timestamp,
        version: data.version,
      };

      await writeFile(this.sessionFilePath, JSON.stringify(payload, null, 2), 'utf-8');
      this.logger.info(
        { component: 'BrowserSession', path: this.sessionFilePath },
        'Session state saved and encrypted'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BrowserSession', error: message }, 'Failed to save session state');
      throw new CriticalError(`Session save failed: ${message}`, 'SESSION_SAVE_FAILED');
    }
  }

  /**
   * Load and decrypt session state from file.
   */
  async load(): Promise<BrowserSessionState | null> {
    if (!existsSync(this.sessionFilePath)) {
      this.logger.debug({ component: 'BrowserSession', path: this.sessionFilePath }, 'No saved session state found');
      return null;
    }

    try {
      const raw = await readFile(this.sessionFilePath, 'utf-8');
      const payload: EncryptedSessionState = JSON.parse(raw);

      const decrypted = decryptJSON<BrowserSessionState>({
        ciphertext: payload.encrypted,
        iv: payload.iv,
        tag: payload.tag,
      });

      // Validate version
      if (decrypted.version !== SESSION_VERSION) {
        this.logger.warn(
          { component: 'BrowserSession', expected: SESSION_VERSION, got: decrypted.version },
          'Session version mismatch, ignoring saved state'
        );
        return null;
      }

      // Check expiration (sessions older than 7 days are considered stale)
      const ageMs = Date.now() - new Date(decrypted.timestamp).getTime();
      const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
      if (ageMs > maxAgeMs) {
        this.logger.warn(
          { component: 'BrowserSession', ageDays: Math.round(ageMs / 86400000) },
          'Session state is stale, ignoring'
        );
        return null;
      }

      this.currentState = decrypted;
      this.logger.info(
        { component: 'BrowserSession', cookieCount: decrypted.cookies.length, ageHours: Math.round(ageMs / 3600000) },
        'Session state loaded'
      );

      return decrypted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BrowserSession', error: message }, 'Failed to load session state');
      return null;
    }
  }

  /**
   * Restore session state into a browser context.
   */
  async restore(context: BrowserContext, state?: BrowserSessionState): Promise<void> {
    const data = state || this.currentState || (await this.load());
    if (!data) {
      this.logger.debug({ component: 'BrowserSession' }, 'No session state to restore');
      return;
    }

    try {
      // Restore cookies
      const page = context.pages()[0] || await context.newPage();
      for (const cookie of data.cookies) {
        try {
          await context.addCookies([{
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.expires,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite,
          }]);
        } catch (err) {
          this.logger.debug(
            { component: 'BrowserSession', cookieName: cookie.name, error: String(err) },
            'Failed to restore cookie'
          );
        }
      }

      // Restore localStorage
      for (const origin of data.origins) {
        try {
          await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 10000 });
          for (const item of origin.localStorage) {
            await page.evaluate(
              ({ key, value }) => {
                localStorage.setItem(key, value);
              },
              { key: item.name, value: item.value }
            );
          }
        } catch (err) {
          this.logger.debug(
            { component: 'BrowserSession', origin: origin.origin, error: String(err) },
            'Failed to restore origin storage'
          );
        }
      }

      this.logger.info(
        { component: 'BrowserSession', cookiesRestored: data.cookies.length },
        'Session state restored to browser'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BrowserSession', error: message }, 'Failed to restore session state');
      throw new TransientError(`Session restore failed: ${message}`, 'SESSION_RESTORE_FAILED');
    }
  }

  /**
   * Check if the page is authenticated by looking for authenticated UI elements.
   * This is a heuristic check that should be customized for BC.Game's UI.
   */
  async checkAuthentication(page: Page): Promise<AuthCheckResult> {
    try {
      // Look for common authenticated indicators
      const indicators = await page.evaluate(() => {
        const results: Record<string, boolean> = {};
        // Check for user menu, balance display, or logout button
        results.hasUserMenu = !!document.querySelector('[data-testid="user-menu"], .user-menu, .account-menu, [class*="user"][class*="menu"]');
        results.hasBalance = !!document.querySelector('[data-testid="balance"], .balance, [class*="balance"], [class*="wallet"]');
        results.hasLogout = !!document.querySelector('[data-testid="logout"], .logout, [class*="logout"]');
        results.hasLoginButton = !!document.querySelector('[data-testid="login"], .login-btn, [class*="login"][class*="btn"]');
        return results;
      });

      // Stronger: login CTA visible => unauthenticated; require >=2 positive signals
      const positive = [indicators.hasUserMenu, indicators.hasBalance, indicators.hasLogout].filter(Boolean).length;
      const authenticated = !indicators.hasLoginButton && positive >= 2;
      const method: AuthCheckResult['method'] = authenticated ? 'session-restore' : 'unknown';

      let balance: number | undefined;
      let currency: string | undefined;

      if (authenticated && indicators.hasBalance) {
        try {
          const balanceText = await page.$eval(
            '[data-testid="balance"], .balance, [class*="balance"], [class*="wallet"]',
            (el) => el.textContent || ''
          );
          const match = balanceText.match(/([\d,]+\.?\d*)\s*(\w+)/);
          if (match) {
            balance = parseFloat(match[1].replace(/,/g, ''));
            currency = match[2];
          }
        } catch {
          // Balance parsing is best-effort
        }
      }

      this.logger.debug(
        { component: 'BrowserSession', authenticated, indicators },
        'Authentication check complete'
      );

      return {
        authenticated,
        balance,
        currency,
        method,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BrowserSession', error: message }, 'Authentication check failed');
      return {
        authenticated: false,
        method: 'unknown',
      };
    }
  }

  /**
   * Full session capture and save workflow.
   */
  async captureAndSave(context: BrowserContext): Promise<void> {
    const state = await this.capture(context);
    await this.save(state);
  }

  /**
   * Full session restore workflow.
   */
  async restoreIfAvailable(context: BrowserContext): Promise<BrowserSessionState | null> {
    const state = await this.load();
    if (state) {
      await this.restore(context, state);
    }
    return state;
  }

  /**
   * Clear saved session state.
   */
  async clear(): Promise<void> {
    if (existsSync(this.sessionFilePath)) {
      const { unlink } = await import('fs/promises');
      await unlink(this.sessionFilePath);
      this.logger.info({ component: 'BrowserSession' }, 'Session state cleared');
    }
    this.currentState = null;
  }

  getCurrentState(): BrowserSessionState | null {
    return this.currentState;
  }

  hasSavedSession(): boolean {
    return existsSync(this.sessionFilePath);
  }
}
