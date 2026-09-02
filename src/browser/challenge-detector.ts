/**
 * ChallengeDetector (R1-E) — detect Cloudflare/CAPTCHA/login-wall/WS anomalies.
 */

import { Page } from 'playwright';
import { EventEmitter } from 'events';
import { getLogger } from '../observability/logger';

export type ChallengeKind =
  | 'cloudflare'
  | 'captcha'
  | 'login_wall'
  | 'region_blocked'
  | 'ws_anomaly'
  | 'unknown_interstitial';

export interface ChallengeEvent {
  kind: ChallengeKind;
  detail: string;
  detectedAt: string;
  url: string;
}

export interface ChallengeDetectorOptions {
  page: Page;
  intervalMs?: number;
  onChallenge?: (event: ChallengeEvent) => void;
}

const CLOUDFLARE_SELECTORS = [
  '#challenge-form',
  '#cf-challenge-running',
  '.cf-browser-verification',
  'text=Checking your browser',
  'text=Just a moment',
];

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  '.g-recaptcha',
  '#captcha',
  '[data-testid="captcha"]',
];

const LOGIN_SELECTORS = [
  'input[type="password"]',
  '[data-testid="login"]',
  'button:has-text("Log in")',
  'button:has-text("Sign in")',
];

export class ChallengeDetector extends EventEmitter {
  private readonly page: Page;
  private readonly intervalMs: number;
  private readonly onChallenge?: (event: ChallengeEvent) => void;
  private readonly logger = getLogger();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastChallenge: ChallengeEvent | null = null;
  private wsCloseCodes: number[] = [];

  constructor(options: ChallengeDetectorOptions) {
    super();
    this.page = options.page;
    this.intervalMs = options.intervalMs ?? 5000;
    this.onChallenge = options.onChallenge;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
    this.logger.info({ component: 'ChallengeDetector' }, 'Challenge detector started');
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  recordWsClose(code: number): void {
    this.wsCloseCodes.push(code);
    if (this.wsCloseCodes.length > 20) this.wsCloseCodes.shift();
    // Abnormal closes
    if ([1006, 1011, 1015].includes(code)) {
      void this.raise('ws_anomaly', `WebSocket closed with code ${code}`);
    }
  }

  getLastChallenge(): ChallengeEvent | null {
    return this.lastChallenge;
  }

  async scan(): Promise<ChallengeEvent | null> {
    try {
      const url = this.page.url();

      for (const sel of CLOUDFLARE_SELECTORS) {
        const n = await this.page.locator(sel).count().catch(() => 0);
        if (n > 0) {
          return this.raise('cloudflare', `Matched selector: ${sel}`, url);
        }
      }

      for (const sel of CAPTCHA_SELECTORS) {
        const n = await this.page.locator(sel).count().catch(() => 0);
        if (n > 0) {
          return this.raise('captcha', `Matched selector: ${sel}`, url);
        }
      }

      // Region / geo restriction (distinct from auth failure)
      const bodyText = await this.page.locator('body').innerText().catch(() => '');
      if (
        /not available in (your|this) (country|region|area)/i.test(bodyText) ||
        /region (is )?restricted/i.test(bodyText) ||
        /geo[- ]?block/i.test(bodyText) ||
        /unavailable in your (country|region)/i.test(bodyText) ||
        /service is not available in/i.test(bodyText)
      ) {
        return this.raise('region_blocked', 'Region restriction content detected', url);
      }

      // Login wall: password field visible AND not on intentional login flow while expecting game
      const title = await this.page.title().catch(() => '');
      if (/access denied|attention required|cf-|just a moment/i.test(title)) {
        return this.raise('unknown_interstitial', `Suspicious title: ${title}`, url);
      }

      // Soft login-wall heuristic
      for (const sel of LOGIN_SELECTORS) {
        const n = await this.page.locator(sel).count().catch(() => 0);
        if (n > 0 && /login|signin|auth/i.test(url)) {
          const game = await this.page.locator('[data-testid="crash-game"], .crash-game').count().catch(() => 0);
          if (game === 0) {
            return this.raise('login_wall', `Login selector matched: ${sel}`, url);
          }
        }
      }

      const pwd = await this.page.locator('input[type="password"]').count().catch(() => 0);
      const game = await this.page.locator('[data-testid="crash-game"], .crash-game').count().catch(() => 0);
      if (pwd > 0 && game === 0 && /login|signin|auth/i.test(url)) {
        return this.raise('login_wall', 'Password field present without game container', url);
      }
    } catch (err) {
      this.logger.debug({ component: 'ChallengeDetector', error: String(err) }, 'Scan error');
    }
    return null;
  }

  private raise(kind: ChallengeKind, detail: string, url = ''): ChallengeEvent {
    const event: ChallengeEvent = {
      kind,
      detail,
      detectedAt: new Date().toISOString(),
      url: url || this.page.url(),
    };
    this.lastChallenge = event;
    this.logger.warn({ component: 'ChallengeDetector', ...event }, 'Challenge detected');
    this.emit('challenge', event);
    this.onChallenge?.(event);
    return event;
  }
}
