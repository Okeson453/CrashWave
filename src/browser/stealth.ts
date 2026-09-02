/**
 * Advanced Stealth Layer v2
 * Targets modern anti-bot systems (Cloudflare, DataDome, PerimeterX, custom casino bots).
 * Integrates with session-stable FingerprintProfile (never mutate mid-session).
 */

import { BrowserContext, Page, CDPSession } from 'playwright';
import { FingerprintProfile } from './fingerprint';
import { getLogger } from '../observability/logger';

const logger = getLogger();

export interface StealthFingerprint {
  userAgent: string;
  platform: string;
  languages: string[];
  vendor: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  webglVendor: string;
  webglRenderer: string;
  colorDepth: number;
  pixelRatio: number;
  secChUa: string;
  secChUaMobile: string;
  secChUaPlatform: string;
  vendorSub: string;
  productSub: string;
  appVersion: string;
  canvasNoiseSeed?: string;
  audioNoiseSeed?: string;
}

export const DEFAULT_STEALTH_FINGERPRINT: StealthFingerprint = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  platform: 'Win32',
  languages: ['en-US', 'en'],
  vendor: 'Google Inc.',
  hardwareConcurrency: 8,
  deviceMemory: 8,
  maxTouchPoints: 0,
  webglVendor: 'Google Inc. (NVIDIA)',
  webglRenderer:
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)',
  colorDepth: 24,
  pixelRatio: 1,
  secChUa: '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
  secChUaMobile: '?0',
  secChUaPlatform: '"Windows"',
  vendorSub: '',
  productSub: '20030107',
  appVersion:
    '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};

export function fingerprintToStealth(fp: FingerprintProfile): StealthFingerprint {
  return {
    userAgent: fp.userAgent,
    platform: fp.platform,
    languages: fp.languages,
    vendor: fp.vendor,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    maxTouchPoints: 0,
    webglVendor: fp.webglVendor,
    webglRenderer: fp.webglRenderer,
    colorDepth: fp.screen.colorDepth,
    pixelRatio: fp.devicePixelRatio,
    secChUa: fp.secChUa,
    secChUaMobile: '?0',
    secChUaPlatform: fp.secChUaPlatform,
    vendorSub: '',
    productSub: '20030107',
    appVersion: fp.userAgent.replace(/^Mozilla\//, ''),
    canvasNoiseSeed: fp.canvasNoiseSeed,
    audioNoiseSeed: fp.audioNoiseSeed,
  };
}

/** Production-minimal Chromium flags (full set via STEALTH_FULL_FLAGS=1 in launch-config). */
export const STEALTH_BROWSER_ARGS = [
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
];

export function stealthLaunchArgs(disableAutomationControlled = true): string[] {
  try {
    const args = [...STEALTH_BROWSER_ARGS];
    if (!disableAutomationControlled) {
      return args.filter((a) => !a.includes('AutomationControlled'));
    }
    return args.filter((a) => !a.includes('enable-automation'));
  } catch {
    return [...STEALTH_BROWSER_ARGS];
  }
}

/** Hardened args with optional real GPU / viewport — see evasion/launch-config */
export { buildHardenedLaunchArgs, hardenedContextOptions } from './evasion/launch-config.js';

export function buildAdvancedStealthInitScript(fp: StealthFingerprint): string {
  return `
(function() {
  'use strict';
  const fp = ${JSON.stringify(fp)};
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  } catch (e) {}
  try {
    window.chrome = window.chrome || { runtime: {} };
  } catch (e) {}
  try {
    delete window.__playwright;
    delete window.__pw_manual;
    delete window.playwright;
  } catch (e) {}
})();
`;
}

export function buildStealthInitScript(fp: StealthFingerprint): string {
  return buildAdvancedStealthInitScript(fp);
}

export async function applyCdpStealth(page: Page, fp: StealthFingerprint): Promise<void> {
  try {
    if (typeof page.context !== 'function') return;
    const ctx = page.context();
    if (!ctx || typeof ctx.newCDPSession !== 'function') return;
    const client: CDPSession = await ctx.newCDPSession(page);
    await client.send('Network.setUserAgentOverride', {
      userAgent: fp.userAgent,
      acceptLanguage: fp.languages.join(','),
      platform: fp.platform,
    });
    logger.debug({ component: 'Stealth' }, 'CDP User-Agent applied');
  } catch (err) {
    logger.warn({ component: 'Stealth', error: String(err) }, 'CDP stealth application failed (non-fatal)');
  }
}

export async function applyStealthToContext(
  context: BrowserContext,
  fingerprint: FingerprintProfile | StealthFingerprint = DEFAULT_STEALTH_FINGERPRINT,
  _options?: { canvasNoise?: boolean; webglNoise?: boolean; audioNoise?: boolean }
): Promise<void> {
  if (typeof context.addInitScript !== 'function') {
    logger.debug({ component: 'Stealth' }, 'Context does not support addInitScript; skipping');
    return;
  }
  const fp: StealthFingerprint =
    'profileId' in (fingerprint as object)
      ? fingerprintToStealth(fingerprint as FingerprintProfile)
      : (fingerprint as StealthFingerprint);

  await context.addInitScript(buildAdvancedStealthInitScript(fp));
  try {
    await context.setExtraHTTPHeaders({
      'Accept-Language': fp.languages.join(',') + ';q=0.9',
      'sec-ch-ua': fp.secChUa,
      'sec-ch-ua-mobile': fp.secChUaMobile,
      'sec-ch-ua-platform': fp.secChUaPlatform,
    });
  } catch {
    /* mock / closed */
  }
  logger.info(
    { component: 'Stealth', userAgent: fp.userAgent.slice(0, 48) + '...' },
    'Stealth applied to context'
  );
}

export async function applyStealthToPage(
  page: Page,
  fingerprint: FingerprintProfile | StealthFingerprint = DEFAULT_STEALTH_FINGERPRINT
): Promise<void> {
  const fp: StealthFingerprint =
    'profileId' in (fingerprint as object)
      ? fingerprintToStealth(fingerprint as FingerprintProfile)
      : (fingerprint as StealthFingerprint);
  const script = buildAdvancedStealthInitScript(fp);
  if (typeof page.addInitScript === 'function') {
    try {
      await page.addInitScript(script);
    } catch (err) {
      logger.debug({ component: 'Stealth', error: String(err) }, 'page.addInitScript failed');
    }
  }
  await applyCdpStealth(page, fp);
  try {
    await page.evaluate(script);
  } catch {
    /* not ready */
  }
}

export async function applyStealthHintsToPage(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch {
        /* ignore */
      }
    });
  } catch (err) {
    logger.debug({ component: 'Stealth', error: String(err) }, 'Page stealth hint failed');
  }
}
