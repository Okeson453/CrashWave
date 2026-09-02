/**
 * HTTP client for the remote Browser Worker (runs in a BC.Game-allowed region).
 */

import { getLogger } from '../../observability/logger';
import type { BrowserWorkerRequest, BrowserWorkerResponse } from './types';

const logger = () => getLogger().child({ component: 'BrowserWorkerClient' });

const LOGIN_TIMEOUT_MS = Number(process.env.BROWSER_WORKER_LOGIN_TIMEOUT_MS ?? 150_000);
const DEFAULT_TIMEOUT_MS = Number(process.env.BROWSER_WORKER_TIMEOUT_MS ?? 90_000);

export interface BrowserWorkerClientOptions {
  baseUrl: string;
  authToken?: string;
  timeoutMs?: number;
}

export class BrowserWorkerClient {
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: BrowserWorkerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.authToken = options.authToken;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private resolveTimeout(command: BrowserWorkerRequest['command']): number {
    if (command === 'login') return LOGIN_TIMEOUT_MS;
    if (command === 'ping' || command === 'health') return Math.min(this.defaultTimeoutMs, 15_000);
    return this.defaultTimeoutMs;
  }

  async invoke(
    req: BrowserWorkerRequest,
    correlationId: string = crypto.randomUUID()
  ): Promise<BrowserWorkerResponse> {
    const url = `${this.baseUrl}/v1/browser`;
    const timeoutMs = this.resolveTimeout(req.command);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Correlation-ID': correlationId,
      };
      if (this.authToken) {
        headers.Authorization = `Bearer ${this.authToken}`;
      }

      const bodyPayload = { ...req, requestId: req.requestId ?? correlationId, correlationId };
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });

      const body = (await res.json().catch(() => ({}))) as BrowserWorkerResponse;
      if (!res.ok && !body.code) {
        return {
          ok: false,
          code: res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR',
          message: `Worker HTTP ${res.status}`,
          ts: new Date().toISOString(),
        };
      }
      return {
        ...body,
        ts: body.ts ?? new Date().toISOString(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger().error({ error: message, url, correlationId }, 'Browser worker invoke failed');
      return {
        ok: false,
        code: 'INTERNAL_ERROR',
        message: `Browser worker unreachable: ${message}`,
        ts: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async health(correlationId?: string): Promise<BrowserWorkerResponse> {
    return this.invoke({ command: 'health' }, correlationId);
  }

  async login(
    email: string,
    password: string,
    tenantId?: string,
    correlationId?: string
  ): Promise<BrowserWorkerResponse> {
    return this.invoke(
      {
        command: 'login',
        email,
        password,
        tenantId,
      },
      correlationId ?? crypto.randomUUID()
    );
  }

  async classifyLoginPage(tenantId?: string, correlationId?: string): Promise<BrowserWorkerResponse> {
    return this.invoke({ command: 'classify_login_page', tenantId }, correlationId);
  }

  async startSession(tenantId?: string, correlationId?: string): Promise<BrowserWorkerResponse> {
    return this.invoke({ command: 'start_session', tenantId }, correlationId);
  }

  async stopSession(tenantId?: string, correlationId?: string): Promise<BrowserWorkerResponse> {
    return this.invoke({ command: 'stop_session', tenantId }, correlationId);
  }

  async status(tenantId?: string, correlationId?: string): Promise<BrowserWorkerResponse> {
    return this.invoke({ command: 'status', tenantId }, correlationId);
  }
}

/** True when control plane should delegate Playwright to a remote worker. */
export function isRemoteBrowserWorkerConfigured(): boolean {
  const url = process.env.BROWSER_WORKER_URL?.trim();
  return !!url && url.length > 8;
}

export function createBrowserWorkerClientFromEnv(): BrowserWorkerClient | null {
  if (!isRemoteBrowserWorkerConfigured()) return null;
  return new BrowserWorkerClient({
    baseUrl: process.env.BROWSER_WORKER_URL!,
    authToken: process.env.BROWSER_WORKER_TOKEN,
    timeoutMs: Number(process.env.BROWSER_WORKER_TIMEOUT_MS ?? 90_000),
  });
}
