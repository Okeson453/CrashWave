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
import { detectRegionRestriction } from './region-restriction-detector';

const SESSION_FILE = 'session-state.enc';
const SESSION_VERSION = 1;

export interface SessionStoreOptions {
  profileDirectory: string;
  sessionFileName?: string;
}

function isTargetCrashed(message: string): boolean {
  return (
    /Target crashed/i.test(message) ||
    /Target page, context or browser has been closed/i.test(message) ||
    /page has been closed/i.test(message) ||
    /Session closed/i.test(message)
  );
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
          sessionStorage: [],
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

  async save(state?: BrowserSessionState): Promise<void> {
    const data = state || this.currentState;
    if (!data) {
      throw new CriticalError('No session state to save', 'NO_SESSION_STATE');
    }
    try {
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
      throw new TransientError(`Session save failed: ${message}`, 'SESSION_SAVE_FAILED');
    }
  }

  async captureAndSave(context: BrowserContext): Promise<BrowserSessionState> {
    const state = await this.capture(context);
    await this.save(state);
    return state;
  }

  async restore(context: BrowserContext, state?: BrowserSessionState): Promise<void> {
    const data = state || this.currentState;
    if (!data) {
      throw new CriticalError('No session state to restore', 'NO_SESSION_STATE');
    }
    try {
      for (const cookie of data.cookies) {
        try {
          await context.addCookies([
            {
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              expires: cookie.expires,
              httpOnly: cookie.httpOnly,
              secure: cookie.secure,
              sameSite: cookie.sameSite,
            },
          ]);
        } catch (err) {
          this.logger.debug(
            { component: 'BrowserSession', cookieName: cookie.name, error: String(err) },
            'Failed to restore cookie'
          );
        }
      }
      this.currentState = data;
      this.logger.info({ component: 'BrowserSession' }, 'Session state restored');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BrowserSession', error: message }, 'Failed to restore session');
      throw new TransientError(`Session restore failed: ${message}`, 'SESSION_RESTORE_FAILED');
    }
  }

  async restoreIfAvailable(context: BrowserContext): Promise<boolean> {
    try {
      if (!existsSync(this.sessionFilePath)) {
        return false;
      }
      const raw = await readFile(this.sessionFilePath, 'utf-8');
      const payload = JSON.parse(raw) as EncryptedSessionState;
      const state = decryptJSON<BrowserSessionState>({
        ciphertext: payload.encrypted,
        iv: payload.iv,
        tag: payload.tag,
      });
      await this.restore(context, state);
      return true;
    } catch (error) {
      this.logger.warn(
        { component: 'BrowserSession', error: String(error) },
        'Could not restore session from disk'
      );
      return false;
    }
  }

  /**
   * Check if the page is authenticated using Playwright locators only.
   * Region restriction is evaluated before normal auth heuristics.
   */
  async checkAuthentication(page: Page): Promise<AuthCheckResult> {
    try {
      if (page.isClosed()) {
        return {
          authenticated: false,
          method: 'unknown',
          regionBlocked: false,
          detail: 'PAGE_CLOSED',
        };
      }

      let url = '';
      try {
        url = page.url();
      } catch {
        return {
          authenticated: false,
          method: 'unknown',
          regionBlocked: false,
          detail: 'PAGE_UNAVAILABLE',
        };
      }

      // Region restriction before normal auth heuristics (never misclassify as auth-required)
      const region = await detectRegionRestriction(page);
      if (region.restricted) {
        this.logger.warn(
          {
            component: 'BrowserSession',
            url: region.currentUrl ?? url,
            kind: region.kind,
            detail: region.detail,
          },
          'Region restriction page detected'
        );
        return {
          authenticated: false,
          method: 'unknown',
          regionBlocked: true,
          regionDetail: region.detail,
          detail: region.detail ?? 'REGION_BLOCKED',
        };
      }

      const countVisible = async (selector: string): Promise<number> => {
        try {
          return await page.locator(selector).count();
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          if (isTargetCrashed(m)) throw err;
          return 0;
        }
      };

      const hasUserMenu =
        (await countVisible(
          '[data-testid="user-menu"], .user-menu, .account-menu, [class*="user"][class*="menu"]'
        )) > 0;
      const hasBalance =
        (await countVisible(
          '[data-testid="balance"], .balance, [class*="balance"], [class*="wallet"]'
        )) > 0;
      const hasLogout =
        (await countVisible('[data-testid="logout"], .logout, [class*="logout"]')) > 0;
      const hasLoginButton =
        (await countVisible(
          '[data-testid="login"], .login-btn, [class*="login"][class*="btn"]'
        )) > 0;
      const hasPasswordField = (await countVisible('input[type="password"]')) > 0;
      const onLoginPath = /\/login|\/signin|\/sign-in|\/auth/i.test(url);

      const indicators = {
        hasUserMenu,
        hasBalance,
        hasLogout,
        hasLoginButton,
        hasPasswordField,
        onLoginPath,
      };

      if (hasPasswordField || onLoginPath) {
        const positive = [hasUserMenu, hasBalance, hasLogout].filter(Boolean).length;
        if (positive < 2) {
          this.logger.debug(
            { component: 'BrowserSession', url, indicators },
            'On login path / password field — not authenticated'
          );
          return {
            authenticated: false,
            method: 'unknown',
            regionBlocked: false,
            detail: 'LOGIN_REQUIRED',
          };
        }
      }

      const positive = [hasUserMenu, hasBalance, hasLogout].filter(Boolean).length;
      const authenticated = !hasLoginButton && !hasPasswordField && positive >= 2;
      const method: AuthCheckResult['method'] = authenticated ? 'session-restore' : 'unknown';

      let balance: number | undefined;
      let currency: string | undefined;

      if (authenticated && hasBalance) {
        try {
          const balanceText =
            (await page
              .locator('[data-testid="balance"], .balance, [class*="balance"], [class*="wallet"]')
              .first()
              .textContent({ timeout: 2000 })
              .catch(() => '')) || '';
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
        { component: 'BrowserSession', authenticated, indicators, url },
        'Authentication check complete'
      );

      return {
        authenticated,
        balance,
        currency,
        method,
        regionBlocked: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'BrowserSession', error: message }, 'Authentication check failed');

      if (isTargetCrashed(message)) {
        return {
          authenticated: false,
          method: 'unknown',
          regionBlocked: false,
          detail: 'TARGET_CRASHED',
        };
      }

      return {
        authenticated: false,
        method: 'unknown',
        regionBlocked: false,
        detail: message,
      };
    }
  }

  getSessionFilePath(): string {
    return this.sessionFilePath;
  }

  getCurrentState(): BrowserSessionState | null {
    return this.currentState;
  }
}
