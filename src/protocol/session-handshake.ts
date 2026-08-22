/**
 * Session Handshaking & Isolation
 * Browser context ONLY for identity negotiation + cookie capture.
 * High-speed execution handed to NativeSocketWorker.
 */
import type { BrowserContext, Page, Cookie } from 'playwright';
import { getLogger } from '../observability/logger';
import type { Ja4Profile } from '../network/tls/ja4-fingerprint';

const logger = () => getLogger().child({ component: 'SessionHandshake' });

export interface HandshakeResult {
  cookies: Cookie[];
  cookieHeader: string;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  userAgent: string;
  wsEndpoint: string | null;
  tokens: Record<string, string>;
  capturedAt: Date;
}

export interface HandshakeOptions {
  page: Page;
  context: BrowserContext;
  challengeSelectors?: string[];
  challengeTimeoutMs?: number;
  discoverWsEndpoint?: boolean;
  tokenKeys?: string[];
}

export async function captureSession(opts: HandshakeOptions): Promise<HandshakeResult> {
  const {
    page, context,
    challengeSelectors = ['[data-sitekey]','iframe[src*="turnstile"]','iframe[src*="challenges.cloudflare"]','#challenge-form','.cf-challenge'],
    challengeTimeoutMs = 120_000,
    discoverWsEndpoint = true,
    tokenKeys = ['token','authToken','access_token','session','jwt'],
  } = opts;

  const start = Date.now();
  logger().info('Session handshake — waiting for challenges');

  const deadline = Date.now() + challengeTimeoutMs;
  while (Date.now() < deadline) {
    const still = await page.evaluate((sels) => sels.some((s) => !!document.querySelector(s)), challengeSelectors).catch(() => false);
    if (!still) break;
    await page.waitForTimeout(1500);
  }

  const cookies = await context.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  const storage = await page.evaluate((keys) => {
    const ls: Record<string, string> = {}, ss: Record<string, string> = {}, tokens: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); if (k) ls[k] = localStorage.getItem(k) || '';
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i); if (k) ss[k] = sessionStorage.getItem(k) || '';
    }
    for (const key of keys) {
      const v = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (v) tokens[key] = v;
    }
    return { ls, ss, tokens };
  }, tokenKeys);

  let wsEndpoint: string | null = null;
  if (discoverWsEndpoint) {
    wsEndpoint = await page.evaluate(() => {
      for (const s of Array.from(document.querySelectorAll('script'))) {
        const m = (s.textContent || '').match(/wss?:\/\/[^\s"'`]+crash[^\s"'`]*/i);
        if (m) return m[0];
      }
      return null;
    }).catch(() => null);
  }

  const userAgent = await page.evaluate(() => navigator.userAgent);
  const result: HandshakeResult = {
    cookies, cookieHeader,
    localStorage: storage.ls, sessionStorage: storage.ss,
    userAgent, wsEndpoint, tokens: storage.tokens, capturedAt: new Date(),
  };
  logger().info({ cookieCount: cookies.length, tokenKeys: Object.keys(result.tokens), wsEndpoint, elapsedMs: Date.now() - start }, 'Handshake complete');
  return result;
}

export function buildNativeHeaders(handshake: HandshakeResult, ja4: Ja4Profile, extra?: Record<string, string>): Record<string, string> {
  return {
    'User-Agent': ja4.userAgent || handshake.userAgent,
    Cookie: handshake.cookieHeader,
    Origin: extra?.Origin || 'https://bc.game',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    ...extra,
  };
}
