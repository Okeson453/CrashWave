/**
 * BC.Game login form automation — submit email/password once, never log secrets.
 *
 * Classify page state BEFORE form fill. Do not mislabel GEO_RESTRICTED as LOGIN_FORM_NOT_FOUND.
 *
 *   PAGE_LOADED
 *     ├── LOGIN_FORM          → proceed with authentication
 *     ├── AUTHENTICATED       → reuse session
 *     ├── GEO_RESTRICTED      → stop + report (primary failure on blocked host IP)
 *     ├── SECURITY_CHALLENGE  → stop + operator action
 *     └── UNKNOWN             → diagnostics only
 */

import type { Page, Locator } from 'playwright';
import { HumanInput } from './human-input';
import { getLogger } from '../observability/logger';
import { BC_GAME_URLS } from '../game/constants';
import { robustNavigate, formatNavigationFailure } from './navigation';

const logger = () => getLogger().child({ component: 'BcGameLogin' });

export type LoginPageState =
  | 'LOGIN_FORM'
  | 'AUTHENTICATED'
  | 'GEO_RESTRICTED'
  | 'SECURITY_CHALLENGE'
  | 'UNKNOWN';

export interface LoginPageDiagnostics {
  requestedUrl: string;
  finalUrl: string;
  pageTitle: string;
  detectedPageState: LoginPageState;
  regionRestrictionDetected: boolean;
  browserReady: boolean;
  bodySnippet: string;
}

export interface BcGameLoginResult {
  ok: boolean;
  authenticated: boolean;
  regionBlocked?: boolean;
  detail?: string;
  pageState?: LoginPageState;
  diagnostics?: LoginPageDiagnostics;
}

const LOGIN_URLS = [
  'https://bc.game/login/signin',
  'https://bc.game/auth/signin',
  BC_GAME_URLS.login,
];

const EMAIL_SELECTORS = [
  'input[placeholder*="Email / Phone" i]',
  'input[placeholder*="Email/Phone" i]',
  'input[placeholder*="Email" i]',
  'input[placeholder*="Phone" i]',
  'input[placeholder*="phone" i]',
  'input[placeholder*="mobile" i]',
  'input[placeholder*="username" i]',
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[name="account"]',
  'input[name="login"]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'form input[type="text"]',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[autocomplete="current-password"]',
  'input[placeholder*="Password" i]',
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'button:has-text("Sign in")',
  'button:has-text("Sign In")',
  'button:has-text("Log in")',
  'button:has-text("Login")',
  '[data-testid="login-submit"]',
  'button.login',
];

function isRegionBlockedText(text: string): boolean {
  return (
    /not accept players from your region/i.test(text) ||
    /do not accept players from your region/i.test(text) ||
    /not available in (your|this) (country|region|area)/i.test(text) ||
    /region (is )?restricted/i.test(text) ||
    /geo[- ]?block/i.test(text) ||
    /unavailable in your (country|region)/i.test(text) ||
    /service is not available in/i.test(text) ||
    /we don't serve players from your location/i.test(text) ||
    /gaming license regulations/i.test(text)
  );
}

function isChallengeText(text: string): boolean {
  return (
    /checking your browser/i.test(text) ||
    /just a moment/i.test(text) ||
    /cloudflare/i.test(text) ||
    /verify you are human/i.test(text) ||
    /attention required/i.test(text) ||
    /enable javascript and cookies/i.test(text)
  );
}

async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      const n = await loc.count().catch(() => 0);
      if (n > 0 && (await loc.isVisible().catch(() => false))) {
        return loc;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function dismissCookieIfPresent(page: Page): Promise<void> {
  const candidates = [
    'button:has-text("Accept")',
    'button:has-text("I Accept")',
    'button:has-text("Agree")',
    '[class*="cookie"] button',
  ];
  for (const sel of candidates) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click({ timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(400);
        return;
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Classify login page after navigation. Call before any credential fill.
 * GEO_RESTRICTED is primary over missing form fields.
 */
export async function classifyLoginPage(
  page: Page,
  requestedUrl: string
): Promise<LoginPageDiagnostics> {
  const finalUrl = page.url();
  const pageTitle = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const bodySnippet = bodyText.slice(0, 320).replace(/\s+/g, ' ').trim();

  const regionRestrictionDetected = isRegionBlockedText(bodyText);
  if (regionRestrictionDetected) {
    return {
      requestedUrl,
      finalUrl,
      pageTitle,
      detectedPageState: 'GEO_RESTRICTED',
      regionRestrictionDetected: true,
      browserReady: true,
      bodySnippet,
    };
  }

  if (isChallengeText(bodyText)) {
    return {
      requestedUrl,
      finalUrl,
      pageTitle,
      detectedPageState: 'SECURITY_CHALLENGE',
      regionRestrictionDetected: false,
      browserReady: true,
      bodySnippet,
    };
  }

  const emailField = await firstVisible(page, EMAIL_SELECTORS);
  const passField = await firstVisible(page, PASSWORD_SELECTORS);
  if (emailField && passField) {
    return {
      requestedUrl,
      finalUrl,
      pageTitle,
      detectedPageState: 'LOGIN_FORM',
      regionRestrictionDetected: false,
      browserReady: true,
      bodySnippet,
    };
  }

  // Already signed in: balance / user chrome, no password field on auth path
  const stillPwd = await page.locator('input[type="password"]').count().catch(() => 0);
  const hasUser = await page
    .locator('[data-testid="user-menu"], .user-menu, [class*="balance"], [class*="wallet"]')
    .count()
    .catch(() => 0);
  if (stillPwd === 0 && hasUser > 0 && !/login|signin|auth/i.test(finalUrl)) {
    return {
      requestedUrl,
      finalUrl,
      pageTitle,
      detectedPageState: 'AUTHENTICATED',
      regionRestrictionDetected: false,
      browserReady: true,
      bodySnippet,
    };
  }

  return {
    requestedUrl,
    finalUrl,
    pageTitle,
    detectedPageState: 'UNKNOWN',
    regionRestrictionDetected: false,
    browserReady: true,
    bodySnippet,
  };
}

function logDiagnostics(d: LoginPageDiagnostics, extra?: Record<string, unknown>): void {
  logger().info(
    {
      requestedUrl: d.requestedUrl,
      finalUrl: d.finalUrl,
      pageTitle: d.pageTitle,
      detectedPageState: d.detectedPageState,
      regionRestrictionDetected: d.regionRestrictionDetected,
      browserReady: d.browserReady,
      bodySnippet: d.bodySnippet,
      ...extra,
    },
    'Login page classification'
  );
}

/**
 * Navigate to login page (if needed) and submit credentials via human-like input.
 * Password must be discarded by the caller after this returns.
 */
export async function submitBcGameLogin(
  page: Page,
  email: string,
  password: string,
  options?: { loginUrl?: string; timeoutMs?: number }
): Promise<BcGameLoginResult> {
  const preferredUrl = options?.loginUrl ?? LOGIN_URLS[0];
  const timeoutMs = options?.timeoutMs ?? 45_000;
  let requestedUrl = preferredUrl;

  try {
    const current = page.url();
    if (!/login|signin|sign-in|auth/i.test(current)) {
      let navigated = false;
      let lastNavDetail = '';
      for (const url of [preferredUrl, ...LOGIN_URLS.filter((u) => u !== preferredUrl)]) {
        requestedUrl = url;
        const diag = await robustNavigate(page, url, {
          timeoutMs: Math.max(timeoutMs, 60_000),
          retries: 2,
          waitUntil: 'domcontentloaded',
        });
        if (diag.navigationStatus === 'ok') {
          navigated = true;
          break;
        }
        lastNavDetail = formatNavigationFailure(diag);
        logger().warn(
          {
            url,
            navigationError: diag.navigationError,
            finalUrl: diag.finalUrl,
            pageTitle: diag.pageTitle,
          },
          'Login URL navigation failed, trying next'
        );
      }
      if (!navigated) {
        return {
          ok: false,
          authenticated: false,
          detail: `LOGIN_NAVIGATION_FAILED: ${lastNavDetail}`.slice(0, 600),
          pageState: 'UNKNOWN',
        };
      }
    } else {
      requestedUrl = current;
    }

    await page.waitForTimeout(2500);
    await dismissCookieIfPresent(page);
    await page.waitForTimeout(500);

    // Soft wait for SPA form attach (does not change classification priority)
    await page
      .locator('input[type="password"], input[placeholder*="Password" i]')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .catch(() => undefined);

    const diagnostics = await classifyLoginPage(page, requestedUrl);
    logDiagnostics(diagnostics);

    if (diagnostics.detectedPageState === 'GEO_RESTRICTED') {
      logger().warn(
        {
          requestedUrl: diagnostics.requestedUrl,
          finalUrl: diagnostics.finalUrl,
          pageTitle: diagnostics.pageTitle,
        },
        'GEO_RESTRICTION_DETECTED — login form unavailable from current deployment region/IP; session init stopped'
      );
      return {
        ok: false,
        authenticated: false,
        regionBlocked: true,
        detail: 'GEO_RESTRICTION_DETECTED',
        pageState: 'GEO_RESTRICTED',
        diagnostics,
      };
    }

    if (diagnostics.detectedPageState === 'SECURITY_CHALLENGE') {
      return {
        ok: false,
        authenticated: false,
        detail: 'SECURITY_CHALLENGE',
        pageState: 'SECURITY_CHALLENGE',
        diagnostics,
      };
    }

    if (diagnostics.detectedPageState === 'AUTHENTICATED') {
      return {
        ok: true,
        authenticated: true,
        detail: 'ALREADY_AUTHENTICATED',
        pageState: 'AUTHENTICATED',
        diagnostics,
      };
    }

    if (diagnostics.detectedPageState !== 'LOGIN_FORM') {
      // UNKNOWN — do not invent LOGIN_FORM_NOT_FOUND as root cause when geo may still apply
      logger().warn(
        {
          requestedUrl: diagnostics.requestedUrl,
          finalUrl: diagnostics.finalUrl,
          pageTitle: diagnostics.pageTitle,
          detectedPageState: diagnostics.detectedPageState,
          bodySnippet: diagnostics.bodySnippet,
        },
        'Login page state UNKNOWN — form not classified; stopping without credential submit'
      );
      return {
        ok: false,
        authenticated: false,
        detail: 'LOGIN_PAGE_UNKNOWN',
        pageState: 'UNKNOWN',
        diagnostics,
      };
    }

    const human = new HumanInput(page, { enabled: true });
    const emailField = await firstVisible(page, EMAIL_SELECTORS);
    const passField = await firstVisible(page, PASSWORD_SELECTORS);

    if (!emailField || !passField) {
      // Race: classified as form then fields disappeared — still not a selector-tuning problem
      return {
        ok: false,
        authenticated: false,
        detail: 'LOGIN_FORM_UNSTABLE',
        pageState: 'UNKNOWN',
        diagnostics,
      };
    }

    await human.typeText(emailField, email);
    await human.randomDelay();
    await human.typeText(passField, password);
    await human.randomDelay();

    const submit = await firstVisible(page, SUBMIT_SELECTORS);
    if (submit) {
      await human.click(submit);
    } else {
      await page.keyboard.press('Enter');
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1500);
      const post = await classifyLoginPage(page, requestedUrl);

      if (post.detectedPageState === 'GEO_RESTRICTED') {
        return {
          ok: false,
          authenticated: false,
          regionBlocked: true,
          detail: 'GEO_RESTRICTION_DETECTED',
          pageState: 'GEO_RESTRICTED',
          diagnostics: post,
        };
      }
      if (post.detectedPageState === 'SECURITY_CHALLENGE') {
        return {
          ok: false,
          authenticated: false,
          detail: 'SECURITY_CHALLENGE',
          pageState: 'SECURITY_CHALLENGE',
          diagnostics: post,
        };
      }
      if (post.detectedPageState === 'AUTHENTICATED') {
        return {
          ok: true,
          authenticated: true,
          detail: 'AUTH_UI_VISIBLE',
          pageState: 'AUTHENTICATED',
          diagnostics: post,
        };
      }

      const stillPwd = await page.locator('input[type="password"]').count().catch(() => 0);
      const url = page.url();
      if (stillPwd === 0 && !/login|signin|auth/i.test(url)) {
        return {
          ok: true,
          authenticated: true,
          detail: 'NAVIGATED_AWAY_FROM_LOGIN',
          pageState: 'AUTHENTICATED',
        };
      }

      const body = await page.locator('body').innerText().catch(() => '');
      if (/incorrect|invalid (password|credentials|email)|wrong password/i.test(body)) {
        return { ok: false, authenticated: false, detail: 'AUTH_FAILED', pageState: 'LOGIN_FORM' };
      }
    }

    return { ok: false, authenticated: false, detail: 'AUTH_TIMEOUT', pageState: 'LOGIN_FORM' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger().error({ error: message }, 'BC.Game login submit failed');
    return { ok: false, authenticated: false, detail: message, pageState: 'UNKNOWN' };
  }
}
