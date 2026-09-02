/**
 * Browser Worker HTTP server — owns Playwright in a BC.Game-allowed region.
 *
 * Auth: Authorization: Bearer <BROWSER_WORKER_TOKEN>
 * Endpoint: POST /v1/browser  { command, tenantId?, email?, password? }
 * Health:   GET  /health
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { getLogger } from '../../observability/logger';
import { classifyLoginPage, submitBcGameLogin } from '../bc-game-login';
import { BrowserManager } from '../manager';
import { toLaunchOptions } from '../types';
import type { AppConfig } from '../../config/schema';
import type { BrowserWorkerRequest, BrowserWorkerResponse, BrowserWorkerAccessCode } from './types';
import { BC_GAME_URLS } from '../../game/constants';

const logger = () => getLogger().child({ component: 'BrowserWorkerServer' });

export interface BrowserWorkerServerOptions {
  config: AppConfig;
  port?: number;
  authToken?: string;
  workerId?: string;
  regionHint?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: BrowserWorkerResponse): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function baseResponse(
  partial: Omit<BrowserWorkerResponse, 'ts'> & { ts?: string },
  workerId?: string,
  regionHint?: string
): BrowserWorkerResponse {
  return {
    ...partial,
    workerId,
    regionHint,
    ts: partial.ts ?? new Date().toISOString(),
  };
}

export class BrowserWorkerServer {
  private readonly options: BrowserWorkerServerOptions;
  private browserManager: BrowserManager | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private readonly workerId: string;
  private readonly regionHint: string;

  constructor(options: BrowserWorkerServerOptions) {
    this.options = options;
    this.workerId = options.workerId ?? process.env.BROWSER_WORKER_ID ?? `bw-${process.pid}`;
    this.regionHint = options.regionHint ?? process.env.BROWSER_WORKER_REGION ?? 'unknown';
  }

  async start(): Promise<void> {
    const port = this.options.port ?? parseInt(process.env.BROWSER_WORKER_PORT ?? '8090', 10);
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, () => resolve());
      this.server!.on('error', reject);
    });
    logger().info({ port, workerId: this.workerId, regionHint: this.regionHint }, 'Browser worker listening');
  }

  async stop(): Promise<void> {
    if (this.browserManager) {
      try {
        await this.browserManager.close();
      } catch {
        /* ignore */
      }
      this.browserManager = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const token = this.options.authToken ?? process.env.BROWSER_WORKER_TOKEN;
    if (!token) return true;
    const auth = req.headers.authorization ?? '';
    return auth === `Bearer ${token}`;
  }

  private async ensureBrowser(): Promise<BrowserManager> {
    if (this.browserManager?.isLaunched()) {
      return this.browserManager;
    }
    const launchOptions = toLaunchOptions(
      this.options.config.browser,
      this.options.config.proxy,
      this.options.config.system.mode
    );
    this.browserManager = new BrowserManager(launchOptions);
    await this.browserManager.launch();
    return this.browserManager;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && (url === '/health' || url === '/healthz')) {
        json(
          res,
          200,
          baseResponse(
            {
              ok: true,
              code: 'OK',
              message: 'browser-worker healthy',
              phase: this.browserManager?.isLaunched() ? 'browser_ready' : 'idle',
            },
            this.workerId,
            this.regionHint
          )
        );
        return;
      }

      if (method !== 'POST' || url !== '/v1/browser') {
        json(
          res,
          404,
          baseResponse({ ok: false, code: 'INVALID_REQUEST', message: 'not found' }, this.workerId, this.regionHint)
        );
        return;
      }

      if (!this.authorized(req)) {
        json(
          res,
          401,
          baseResponse({ ok: false, code: 'UNAUTHORIZED', message: 'unauthorized' }, this.workerId, this.regionHint)
        );
        return;
      }

      const raw = await readBody(req);
      let body: BrowserWorkerRequest;
      try {
        body = JSON.parse(raw) as BrowserWorkerRequest;
      } catch {
        json(
          res,
          400,
          baseResponse({ ok: false, code: 'INVALID_REQUEST', message: 'invalid json' }, this.workerId, this.regionHint)
        );
        return;
      }

      const result = await this.dispatch(body);
      const status = result.ok ? 200 : result.code === 'UNAUTHORIZED' ? 401 : 200;
      json(res, status, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger().error({ error: message }, 'Browser worker handler error');
      json(
        res,
        500,
        baseResponse(
          { ok: false, code: 'INTERNAL_ERROR', message: message.slice(0, 300) },
          this.workerId,
          this.regionHint
        )
      );
    }
  }

  private async dispatch(req: BrowserWorkerRequest): Promise<BrowserWorkerResponse> {
    const cmd = req.command;

    if (cmd === 'ping' || cmd === 'health') {
      return baseResponse(
        {
          ok: true,
          code: 'OK',
          message: 'pong',
          phase: this.browserManager?.isLaunched() ? 'browser_ready' : 'idle',
        },
        this.workerId,
        this.regionHint
      );
    }

    if (cmd === 'status') {
      return baseResponse(
        {
          ok: true,
          code: 'OK',
          message: 'status',
          phase: this.browserManager?.isLaunched() ? 'browser_ready' : 'idle',
          authenticated: false,
        },
        this.workerId,
        this.regionHint
      );
    }

    if (cmd === 'stop_session') {
      if (this.browserManager) {
        await this.browserManager.close().catch(() => undefined);
        this.browserManager = null;
      }
      return baseResponse(
        { ok: true, code: 'OK', message: 'session stopped', phase: 'idle' },
        this.workerId,
        this.regionHint
      );
    }

    if (cmd === 'start_session' || cmd === 'classify_login_page' || cmd === 'login') {
      try {
        const mgr = await this.ensureBrowser();
        const page = mgr.getPage();
        const loginUrl = process.env.BC_GAME_LOGIN_URL?.trim() || BC_GAME_URLS.login;

        if (cmd === 'start_session') {
          await mgr.navigate(loginUrl, 'domcontentloaded');
          await page.waitForTimeout(2000);
          const diagnostics = await classifyLoginPage(page, loginUrl);
          logger().info(
            {
              requestedUrl: diagnostics.requestedUrl,
              finalUrl: diagnostics.finalUrl,
              pageTitle: diagnostics.pageTitle,
              detectedPageState: diagnostics.detectedPageState,
              regionRestrictionDetected: diagnostics.regionRestrictionDetected,
              browserReady: diagnostics.browserReady,
            },
            'Browser worker session start classification'
          );

          if (diagnostics.detectedPageState === 'GEO_RESTRICTED') {
            return this.accessBlocked(diagnostics);
          }

          return baseResponse(
            {
              ok: true,
              code: 'OK',
              message: 'session started',
              pageState: diagnostics.detectedPageState,
              phase: 'session_started',
              diagnostics: {
                requestedUrl: diagnostics.requestedUrl,
                finalUrl: diagnostics.finalUrl,
                pageTitle: diagnostics.pageTitle,
                detectedPageState: diagnostics.detectedPageState,
                regionRestrictionDetected: diagnostics.regionRestrictionDetected,
                browserReady: diagnostics.browserReady,
              },
            },
            this.workerId,
            this.regionHint
          );
        }

        if (cmd === 'classify_login_page') {
          const current = page.url();
          if (!/login|signin|auth/i.test(current)) {
            await mgr.navigate(loginUrl, 'domcontentloaded');
            await page.waitForTimeout(2000);
          }
          const diagnostics = await classifyLoginPage(page, loginUrl);
          if (diagnostics.detectedPageState === 'GEO_RESTRICTED') {
            return this.accessBlocked(diagnostics);
          }
          return baseResponse(
            {
              ok: diagnostics.detectedPageState === 'LOGIN_FORM' || diagnostics.detectedPageState === 'AUTHENTICATED',
              code:
                diagnostics.detectedPageState === 'LOGIN_FORM' || diagnostics.detectedPageState === 'AUTHENTICATED'
                  ? 'OK'
                  : diagnostics.detectedPageState === 'SECURITY_CHALLENGE'
                    ? 'SECURITY_CHALLENGE'
                    : 'LOGIN_PAGE_UNKNOWN',
              message: `pageState=${diagnostics.detectedPageState}`,
              pageState: diagnostics.detectedPageState,
              regionBlocked: diagnostics.regionRestrictionDetected,
              diagnostics: {
                requestedUrl: diagnostics.requestedUrl,
                finalUrl: diagnostics.finalUrl,
                pageTitle: diagnostics.pageTitle,
                detectedPageState: diagnostics.detectedPageState,
                regionRestrictionDetected: diagnostics.regionRestrictionDetected,
                browserReady: diagnostics.browserReady,
              },
            },
            this.workerId,
            this.regionHint
          );
        }

        const email = String(req.email ?? '');
        let password = String(req.password ?? '');
        if (!email || !password) {
          return baseResponse(
            { ok: false, code: 'INVALID_REQUEST', message: 'email and password required' },
            this.workerId,
            this.regionHint
          );
        }

        const result = await submitBcGameLogin(page, email, password, { loginUrl });
        password = '';

        if (result.regionBlocked || result.detail === 'BC_GAME_ACCESS_BLOCKED') {
          return this.accessBlocked(result.diagnostics);
        }

        if (result.ok && result.authenticated) {
          return baseResponse(
            {
              ok: true,
              code: 'OK',
              message: result.detail ?? 'authenticated',
              authenticated: true,
              pageState: result.pageState,
              phase: 'authenticated',
              diagnostics: result.diagnostics
                ? {
                    requestedUrl: result.diagnostics.requestedUrl,
                    finalUrl: result.diagnostics.finalUrl,
                    pageTitle: result.diagnostics.pageTitle,
                    detectedPageState: result.diagnostics.detectedPageState,
                    regionRestrictionDetected: result.diagnostics.regionRestrictionDetected,
                    browserReady: result.diagnostics.browserReady,
                  }
                : undefined,
            },
            this.workerId,
            this.regionHint
          );
        }

        const code: BrowserWorkerAccessCode =
          result.detail === 'SECURITY_CHALLENGE'
            ? 'SECURITY_CHALLENGE'
            : result.detail === 'AUTH_TIMEOUT'
              ? 'AUTH_TIMEOUT'
              : result.detail === 'AUTH_FAILED'
                ? 'AUTH_FAILED'
                : result.detail === 'LOGIN_PAGE_UNKNOWN'
                  ? 'LOGIN_PAGE_UNKNOWN'
                  : 'AUTH_FAILED';

        return baseResponse(
          {
            ok: false,
            code,
            message: result.detail ?? 'login failed',
            authenticated: false,
            pageState: result.pageState,
            diagnostics: result.diagnostics
              ? {
                  requestedUrl: result.diagnostics.requestedUrl,
                  finalUrl: result.diagnostics.finalUrl,
                  pageTitle: result.diagnostics.pageTitle,
                  detectedPageState: result.diagnostics.detectedPageState,
                  regionRestrictionDetected: result.diagnostics.regionRestrictionDetected,
                  browserReady: result.diagnostics.browserReady,
                }
              : undefined,
          },
          this.workerId,
          this.regionHint
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger().error({ error: message }, 'Browser worker command failed');
        return baseResponse(
          {
            ok: false,
            code: /BROWSER_|executable|DISPLAY|X server/i.test(message) ? 'BROWSER_FAILED' : 'INTERNAL_ERROR',
            message: message.slice(0, 400),
          },
          this.workerId,
          this.regionHint
        );
      }
    }

    return baseResponse(
      { ok: false, code: 'INVALID_REQUEST', message: `unknown command: ${String(cmd)}` },
      this.workerId,
      this.regionHint
    );
  }

  private accessBlocked(
    diagnostics?: {
      requestedUrl?: string;
      finalUrl?: string;
      pageTitle?: string;
      detectedPageState?: string;
      regionRestrictionDetected?: boolean;
      browserReady?: boolean;
    }
  ): BrowserWorkerResponse {
    logger().warn(
      {
        requestedUrl: diagnostics?.requestedUrl,
        finalUrl: diagnostics?.finalUrl,
        pageTitle: diagnostics?.pageTitle,
        detectedPageState: diagnostics?.detectedPageState ?? 'GEO_RESTRICTED',
        regionRestrictionDetected: true,
        browserReady: diagnostics?.browserReady ?? true,
        workerId: this.workerId,
        regionHint: this.regionHint,
      },
      'BC_GAME_ACCESS_BLOCKED — login form unavailable from this worker region/IP'
    );

    return baseResponse(
      {
        ok: false,
        code: 'BC_GAME_ACCESS_BLOCKED',
        message:
          'BC.Game region restriction detected. The browser reached BC.Game, but the login form is unavailable from the current deployment region/IP. Session initialization stopped.',
        regionBlocked: true,
        pageState: 'GEO_RESTRICTED',
        phase: 'access_blocked',
        diagnostics: diagnostics
          ? {
              requestedUrl: diagnostics.requestedUrl,
              finalUrl: diagnostics.finalUrl,
              pageTitle: diagnostics.pageTitle,
              detectedPageState: diagnostics.detectedPageState ?? 'GEO_RESTRICTED',
              regionRestrictionDetected: true,
              browserReady: diagnostics.browserReady,
            }
          : { detectedPageState: 'GEO_RESTRICTED', regionRestrictionDetected: true },
      },
      this.workerId,
      this.regionHint
    );
  }
}
