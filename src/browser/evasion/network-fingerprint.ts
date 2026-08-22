/**
 * Network fingerprint helpers.
 *
 * Engineering notes:
 * - JS object key order is NOT the same as HTTP/2 wire header order. Playwright
 *   route.continue cannot reliably enforce HPACK field order. We do not claim to.
 * - Blindly rewriting sec-fetch-* on every request breaks XHR/fetch (must not
 *   always be dest=document / mode=navigate).
 * - We only strip known automation headers and backfill safe defaults on
 *   top-level document navigations.
 */

import type { Page, Route, Request } from 'playwright';
import { getLogger } from '../../observability/logger.js';

export interface NetworkFingerprintConfig {
  stripAutomationHeaders: boolean;
  normalizeClientHints: boolean;
  /** Only touch main-frame document navigations when true (default) */
  documentNavigationsOnly: boolean;
  userAgent: string;
  platform: string;
  secChUa?: string;
}

export const DEFAULT_NETWORK_CONFIG: NetworkFingerprintConfig = {
  stripAutomationHeaders: true,
  normalizeClientHints: true,
  documentNavigationsOnly: true,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  platform: '"Windows"',
};

const AUTOMATION_HEADERS = new Set([
  'x-playwright',
  'x-puppeteer',
  'x-automation',
  'x-headless',
  'x-playwright-checkpoint',
]);

export async function applyNetworkNormalization(
  page: Page,
  config: Partial<NetworkFingerprintConfig> = {}
): Promise<void> {
  const logger = getLogger();
  const c = { ...DEFAULT_NETWORK_CONFIG, ...config };
  const chromeVersion = extractChromeVersion(c.userAgent) || '128';
  const secChUa =
    c.secChUa ||
    `"Not/A)Brand";v="8", "Chromium";v="${chromeVersion}", "Google Chrome";v="${chromeVersion}"`;

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    try {
      if (c.documentNavigationsOnly && !isMainFrameDocument(request)) {
        await route.continue();
        return;
      }

      const headers: Record<string, string> = { ...(await request.allHeaders()) };

      if (c.stripAutomationHeaders) {
        for (const key of Object.keys(headers)) {
          if (AUTOMATION_HEADERS.has(key.toLowerCase())) {
            delete headers[key];
          }
        }
      }

      if (c.normalizeClientHints) {
        headers['user-agent'] = c.userAgent;
        headers['sec-ch-ua'] = secChUa;
        headers['sec-ch-ua-mobile'] = '?0';
        headers['sec-ch-ua-platform'] = c.platform;
      }

      // Safe document defaults only
      if (isMainFrameDocument(request)) {
        headers['accept-language'] ??= 'en-US,en;q=0.9';
        headers['upgrade-insecure-requests'] ??= '1';
        headers['sec-fetch-dest'] = 'document';
        headers['sec-fetch-mode'] = 'navigate';
        headers['sec-fetch-site'] ??= headers['sec-fetch-site'] || 'none';
        headers['sec-fetch-user'] = '?1';
      }

      await route.continue({ headers });
    } catch (err) {
      logger.debug(
        { component: 'NetworkFingerprint', error: String(err) },
        'route.continue failed — aborting route safely'
      );
      try {
        await route.continue();
      } catch {
        try {
          await route.abort();
        } catch {
          /* ignore */
        }
      }
    }
  });

  logger.info({ component: 'NetworkFingerprint' }, 'Network header hygiene active');
}

function isMainFrameDocument(request: Request): boolean {
  try {
    if (request.resourceType() !== 'document') return false;
    // isNavigationRequest is the reliable signal for top-level navigations
    if (typeof request.isNavigationRequest === 'function' && !request.isNavigationRequest()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Launch args related to HTTP — cannot set SETTINGS frame from Playwright alone */
export function getHTTP2LaunchArgs(): string[] {
  return ['--disable-quic'];
}

function extractChromeVersion(ua: string): string | null {
  const match = ua.match(/Chrome\/([0-9]+)/);
  return match ? match[1] : null;
}
