/**
 * Browser Worker protocol — control plane ↔ browser worker (allowed region).
 *
 * Railway (or any control plane) must NOT run Playwright against BC.Game when
 * the host IP is geo-restricted. Only the browser worker process, deployed in
 * a BC.Game-permitted region, owns Chromium sessions.
 */

export type BrowserWorkerCommand =
  | 'ping'
  | 'status'
  | 'start_session'
  | 'stop_session'
  | 'login'
  | 'classify_login_page'
  | 'health';

export interface BrowserWorkerRequest {
  command: BrowserWorkerCommand;
  tenantId?: string;
  /** One-shot credentials — never logged or stored by the worker beyond the call */
  email?: string;
  password?: string;
  requestId?: string;
}

export type BrowserWorkerAccessCode =
  | 'OK'
  | 'BC_GAME_ACCESS_BLOCKED'
  | 'SECURITY_CHALLENGE'
  | 'LOGIN_PAGE_UNKNOWN'
  | 'AUTH_FAILED'
  | 'AUTH_TIMEOUT'
  | 'BROWSER_FAILED'
  | 'SESSION_NOT_STARTED'
  | 'UNAUTHORIZED'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR';

export interface BrowserWorkerResponse {
  ok: boolean;
  code: BrowserWorkerAccessCode;
  message: string;
  authenticated?: boolean;
  regionBlocked?: boolean;
  pageState?: string;
  phase?: string;
  diagnostics?: {
    requestedUrl?: string;
    finalUrl?: string;
    pageTitle?: string;
    detectedPageState?: string;
    regionRestrictionDetected?: boolean;
    browserReady?: boolean;
  };
  workerId?: string;
  regionHint?: string;
  ts: string;
}
