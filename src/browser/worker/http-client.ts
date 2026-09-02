/**
 * Phase 3.3 — Control-plane client for browser-worker HTTP API.
 * Main process should call this instead of importing Playwright when
 * BROWSER_WORKER_URL is set.
 */

import { getLogger } from '../../observability/logger.js';

const logger = getLogger();

export interface BrowserWorkerClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

export class BrowserWorkerHttpClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(opts: BrowserWorkerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token ?? process.env.BROWSER_WORKER_TOKEN;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  static fromEnv(): BrowserWorkerHttpClient | null {
    const url = process.env.BROWSER_WORKER_URL?.trim();
    if (!url) return null;
    return new BrowserWorkerHttpClient({ baseUrl: url });
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchJson('/health', { method: 'GET' });
      return Boolean(res);
    } catch {
      return false;
    }
  }

  async command(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.fetchJson('/v1/browser', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  private async fetchJson(
    path: string,
    init: { method: string; body?: string }
  ): Promise<Record<string, unknown>> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: ctrl.signal,
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        logger.warn(
          { component: 'BrowserWorkerHttpClient', status: res.status, json },
          'Browser worker error'
        );
      }
      return json;
    } finally {
      clearTimeout(t);
    }
  }
}

/** True when control plane should not import Playwright */
export function shouldUseRemoteBrowserWorker(): boolean {
  return Boolean(process.env.BROWSER_WORKER_URL?.trim());
}
