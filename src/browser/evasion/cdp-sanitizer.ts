/**
 * CDP Sanitizer — surface reduction & page-side hygiene.
 *
 * Engineering constraints (important):
 * - Playwright *is* the CDP client. We cannot MITM Playwright's internal CDP.
 * - Remapping executionContextId on outgoing commands BREAKS the browser
 *   (IDs must match the renderer). That approach is intentionally NOT used.
 * - We only: (1) refuse high-risk domains on *our* sessions, (2) jitter our
 *   own CDP sends, (3) inject page scripts that scrub classic automation marks.
 */

import type { CDPSession, Page } from 'playwright';
import { getLogger } from '../../observability/logger.js';

export interface CDPSanitizerConfig {
  /** Micro-jitter applied only to sanitizer-mediated sends */
  commandJitterMs: [number, number];
  /** Refuse Debugger/Profiler/HeapProfiler/Overlay on wrapSession/send */
  blockHighRiskDomains: boolean;
}

export const DEFAULT_CDP_CONFIG: CDPSanitizerConfig = {
  commandJitterMs: [2, 12],
  blockHighRiskDomains: true,
};

/** Domains that are high-signal and rarely needed by the automation product */
const BLOCKED_DOMAINS = new Set(['Debugger', 'HeapProfiler', 'Profiler', 'Overlay']);

export class CDPSanitizer {
  private readonly logger = getLogger();
  private readonly config: CDPSanitizerConfig;
  private readonly sessions = new WeakMap<Page, CDPSession>();
  private commandCounter = 0;

  constructor(config: Partial<CDPSanitizerConfig> = {}) {
    this.config = { ...DEFAULT_CDP_CONFIG, ...config };
  }

  wrapSession(session: CDPSession): CDPSanitizedSession {
    return new CDPSanitizedSession(session, this);
  }

  async getSession(page: Page): Promise<CDPSession> {
    const existing = this.sessions.get(page);
    if (existing) return existing;
    const session = await page.context().newCDPSession(page);
    this.sessions.set(page, session);
    return session;
  }

  /**
   * Validate an outgoing method name. Does NOT rewrite context IDs.
   * @throws if domain is blocked
   */
  assertAllowed(method: string): void {
    const domain = method.split('.')[0] ?? '';
    if (this.config.blockHighRiskDomains && BLOCKED_DOMAINS.has(domain)) {
      this.logger.warn({ component: 'CDPSanitizer', method }, 'Blocked high-risk CDP domain');
      throw new Error(`CDP domain blocked by sanitizer: ${domain}`);
    }
  }

  /** @deprecated Use assertAllowed — kept for API compatibility; no longer remaps IDs */
  sanitizeOutgoing(
    method: string,
    params?: Record<string, unknown>
  ): { method: string; params?: Record<string, unknown> } {
    this.assertAllowed(method);
    this.commandCounter++;
    return { method, params };
  }

  /** Incoming events: pass-through (we are not a CDP proxy) */
  sanitizeIncoming(
    event: string,
    params?: Record<string, unknown>
  ): { event: string; params?: Record<string, unknown> } | null {
    const domain = event.split('.')[0] ?? '';
    if (this.config.blockHighRiskDomains && BLOCKED_DOMAINS.has(domain)) {
      return null;
    }
    return { event, params };
  }

  jitterMs(): number {
    const [min, max] = this.config.commandJitterMs;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  static buildDetectionPatchScript(): string {
    return `
(function() {
  'use strict';
  if (window.__sheathCdpPatch) return;
  try { Object.defineProperty(window, '__sheathCdpPatch', { value: 1, configurable: false }); } catch (e) {}

  try {
    var nativePrepare = Error.prepareStackTrace;
    Error.prepareStackTrace = function(err, structuredStack) {
      try {
        var filtered = (structuredStack || []).filter(function(f) {
          var s = f.toString();
          return s.indexOf('__playwright') === -1
            && s.indexOf('pptr:') === -1
            && s.indexOf('devtools://') === -1;
        });
        if (nativePrepare) return nativePrepare(err, filtered);
        return filtered.map(function(f) { return '    at ' + f.toString(); }).join('\\n');
      } catch (e) {
        return nativePrepare ? nativePrepare(err, structuredStack) : String(err);
      }
    };
  } catch (e) {}

  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        value: {}, configurable: true, enumerable: true, writable: true
      });
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        connect: function() {
          return { onMessage: { addListener: function() {} }, postMessage: function() {} };
        },
        sendMessage: function() {},
        id: undefined
      };
    }
  } catch (e) {}

  try {
    var props = Object.getOwnPropertyNames(document);
    for (var i = 0; i < props.length; i++) {
      var p = props[i];
      if (p.indexOf('$cdc_') === 0 || p.indexOf('$chrome_asyncScriptInfo') === 0) {
        try { delete document[p]; } catch (e) {}
      }
    }
  } catch (e) {}
})();`;
  }

  async applyPagePatches(page: Page): Promise<void> {
    await page.addInitScript(CDPSanitizer.buildDetectionPatchScript());
  }

  async send(page: Page, method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.assertAllowed(method);
    await sleep(this.jitterMs());
    const session = await this.getSession(page);
    // Playwright types CDP methods as a large union; cast at the boundary only.
    return (session as CDPSession).send(method as 'Runtime.enable', params as never);
  }

  getCommandCount(): number {
    return this.commandCounter;
  }
}

export class CDPSanitizedSession {
  constructor(
    private readonly session: CDPSession,
    private readonly sanitizer: CDPSanitizer
  ) {}

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sanitizer.assertAllowed(method);
    this.sanitizer.sanitizeOutgoing(method, params);
    await sleep(this.sanitizer.jitterMs());
    return this.session.send(method as 'Runtime.enable', params as never);
  }

  on(event: string, handler: (params: unknown) => void): void {
    this.session.on(event as 'event', ((params: unknown) => {
      const sanitized = this.sanitizer.sanitizeIncoming(event, params as Record<string, unknown>);
      if (sanitized) handler(sanitized.params);
    }) as never);
  }

  off(event: string, handler?: (params: unknown) => void): void {
    if (handler) this.session.off(event as 'event', handler as never);
  }

  detach(): Promise<void> {
    return this.session.detach();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const cdpSanitizer = new CDPSanitizer();
