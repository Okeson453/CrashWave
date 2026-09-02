/**
 * Robust BC.Game navigation layer for Railway / container runtimes.
 * Preflight (DNS → HTTPS → optional Chromium) + goto with retries and full diagnostics.
 * Never logs credentials.
 */
import type { Page, Response } from 'playwright';
import { lookup } from 'node:dns/promises';
import { getLogger } from '../observability/logger';

const logger = getLogger();

export interface NavigationDiagnostics {
  requestedUrl: string;
  finalUrl: string;
  pageTitle: string;
  navigationStatus: 'ok' | 'failed' | 'no_response';
  navigationError?: string;
  httpStatus?: number;
  preflight?: {
    dnsOk: boolean;
    dnsError?: string;
    httpsOk: boolean;
    httpsError?: string;
    httpsStatus?: number;
  };
  attempts: number;
  loadTimeMs: number;
}

export interface RobustNavigateOptions {
  timeoutMs?: number;
  retries?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  /** Skip Chromium goto (preflight only) */
  preflightOnly?: boolean;
}

const TRANSIENT_PATTERNS = [
  /Timeout\s*\d+ms\s*exceeded/i,
  /net::ERR_CONNECTION_TIMED_OUT/i,
  /net::ERR_CONNECTION_RESET/i,
  /net::ERR_CONNECTION_CLOSED/i,
  /net::ERR_CONNECTION_REFUSED/i,
  /net::ERR_NETWORK_CHANGED/i,
  /net::ERR_INTERNET_DISCONNECTED/i,
  /net::ERR_NAME_NOT_RESOLVED/i,
  /net::ERR_SSL_PROTOCOL_ERROR/i,
  /Navigation timeout/i,
  /NS_ERROR_NET/i,
  /socket hang up/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
];

export function isTransientNavigationError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

export function classifyNavigationError(message: string): string {
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(message)) return 'DNS_FAILED';
  if (/ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|Timeout/i.test(message)) return 'TIMEOUT';
  if (/ERR_CONNECTION_RESET|ECONNRESET|ERR_CONNECTION_CLOSED/i.test(message)) return 'CONNECTION_RESET';
  if (/ERR_CERT|SSL|CERT_/i.test(message)) return 'TLS_CERT';
  if (/ERR_CONNECTION_REFUSED/i.test(message)) return 'CONNECTION_REFUSED';
  if (/ERR_TUNNEL|proxy/i.test(message)) return 'PROXY';
  return 'NAVIGATION_ERROR';
}

/** DNS + HTTPS connectivity check before Chromium navigation. */
export async function preflightNavigate(url: string): Promise<NavigationDiagnostics['preflight']> {
  const result: NonNullable<NavigationDiagnostics['preflight']> = {
    dnsOk: false,
    httpsOk: false,
  };

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch (err) {
    result.dnsError = `INVALID_URL: ${err instanceof Error ? err.message : String(err)}`;
    result.httpsError = result.dnsError;
    return result;
  }

  try {
    const records = await lookup(hostname, { all: true });
    result.dnsOk = Array.isArray(records) ? records.length > 0 : !!records;
    if (!result.dnsOk) result.dnsError = 'NO_DNS_RECORDS';
  } catch (err) {
    result.dnsError = err instanceof Error ? err.message : String(err);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timer);
    result.httpsOk = res.status > 0 && res.status < 500;
    result.httpsStatus = res.status;
    if (!result.httpsOk) {
      result.httpsError = `HTTP_${res.status}`;
    }
  } catch (err) {
    result.httpsError = err instanceof Error ? err.message : String(err);
  }

  logger.info(
    {
      component: 'BrowserNavigation',
      hostname,
      dnsOk: result.dnsOk,
      dnsError: result.dnsError,
      httpsOk: result.httpsOk,
      httpsStatus: result.httpsStatus,
      httpsError: result.httpsError,
    },
    'Navigation preflight complete'
  );

  return result;
}

async function safeTitle(page: Page): Promise<string> {
  try {
    return (await page.title()) || '';
  } catch {
    return '';
  }
}

async function safeUrl(page: Page): Promise<string> {
  try {
    return page.url() || '';
  } catch {
    return '';
  }
}

/**
 * Navigate with preflight, 60s timeout default, up to 2 retries on transient network errors.
 * Captures requestedUrl, finalUrl, pageTitle, navigationStatus, navigationError.
 */
export async function robustNavigate(
  page: Page,
  url: string,
  options?: RobustNavigateOptions
): Promise<NavigationDiagnostics> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const maxRetries = options?.retries ?? 2;
  const waitUntil = options?.waitUntil ?? 'domcontentloaded';
  const started = Date.now();

  const preflight = await preflightNavigate(url);

  if (options?.preflightOnly) {
    return {
      requestedUrl: url,
      finalUrl: '',
      pageTitle: '',
      navigationStatus: preflight?.httpsOk ? 'ok' : 'failed',
      navigationError: preflight?.httpsError || preflight?.dnsError,
      preflight,
      attempts: 0,
      loadTimeMs: Date.now() - started,
    };
  }

  let lastError = '';
  let lastResponse: Response | null = null;
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;
    try {
      logger.info(
        {
          component: 'BrowserNavigation',
          requestedUrl: url,
          attempt: attempts,
          timeoutMs,
          waitUntil,
        },
        'Chromium navigation attempt'
      );

      lastResponse = await page.goto(url, { waitUntil, timeout: timeoutMs });
      const finalUrl = await safeUrl(page);
      const pageTitle = await safeTitle(page);
      const httpStatus = lastResponse?.status();

      const diag: NavigationDiagnostics = {
        requestedUrl: url,
        finalUrl,
        pageTitle,
        navigationStatus: lastResponse ? 'ok' : 'no_response',
        httpStatus,
        navigationError: lastResponse ? undefined : 'NO_RESPONSE',
        preflight,
        attempts,
        loadTimeMs: Date.now() - started,
      };

      logger.info(
        {
          component: 'BrowserNavigation',
          requestedUrl: diag.requestedUrl,
          finalUrl: diag.finalUrl,
          pageTitle: diag.pageTitle,
          navigationStatus: diag.navigationStatus,
          httpStatus: diag.httpStatus,
          attempts: diag.attempts,
          loadTimeMs: diag.loadTimeMs,
        },
        'Navigation finished'
      );

      return diag;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const finalUrl = await safeUrl(page);
      const pageTitle = await safeTitle(page);
      const code = classifyNavigationError(lastError);

      logger.warn(
        {
          component: 'BrowserNavigation',
          requestedUrl: url,
          finalUrl,
          pageTitle,
          navigationStatus: 'failed',
          navigationError: lastError,
          errorClass: code,
          attempt: attempts,
        },
        'Navigation attempt failed'
      );

      const canRetry = attempt < maxRetries && isTransientNavigationError(lastError);
      if (canRetry) {
        await page.waitForTimeout(1_000 * (attempt + 1)).catch(() => undefined);
        continue;
      }

      return {
        requestedUrl: url,
        finalUrl,
        pageTitle,
        navigationStatus: 'failed',
        navigationError: `${code}: ${lastError}`.slice(0, 500),
        preflight,
        attempts,
        loadTimeMs: Date.now() - started,
      };
    }
  }

  return {
    requestedUrl: url,
    finalUrl: await safeUrl(page),
    pageTitle: await safeTitle(page),
    navigationStatus: 'failed',
    navigationError: lastError || 'UNKNOWN',
    preflight,
    attempts,
    loadTimeMs: Date.now() - started,
  };
}

/** Format diagnostics for Telegram / logs (no secrets). */
export function formatNavigationFailure(diag: NavigationDiagnostics): string {
  const lines = [
    'Navigation failed',
    `requestedUrl: ${diag.requestedUrl}`,
    `finalUrl: ${diag.finalUrl || '(none)'}`,
    `pageTitle: ${diag.pageTitle || '(none)'}`,
    `status: ${diag.navigationStatus}`,
    diag.navigationError ? `error: ${diag.navigationError}` : null,
    diag.httpStatus != null ? `httpStatus: ${diag.httpStatus}` : null,
    diag.preflight
      ? `preflight: dns=${diag.preflight.dnsOk} https=${diag.preflight.httpsOk}${
          diag.preflight.httpsStatus != null ? ` http=${diag.preflight.httpsStatus}` : ''
        }`
      : null,
    diag.preflight?.dnsError ? `dnsError: ${diag.preflight.dnsError}` : null,
    diag.preflight?.httpsError ? `httpsError: ${diag.preflight.httpsError}` : null,
    `attempts: ${diag.attempts}`,
    `loadTimeMs: ${diag.loadTimeMs}`,
  ].filter(Boolean);
  return lines.join('\n');
}
