/**
 * Staged LOGIN TEST pipeline — independent of ACIE dry-run.
 * Each stage emits its own result so failures are diagnosable.
 *
 * Stages:
 *   BrowserNavigation → LoginPageDetector → RegionRestrictionDetector →
 *   LoginFormDetector → CredentialSubmission → AuthenticationVerifier → SessionPersistence
 */
import type { Page, BrowserContext } from 'playwright';
import { getLogger } from '../observability/logger';
import { detectRegionRestriction } from './region-restriction-detector';
import { classifyLoginPage, submitBcGameLogin } from './bc-game-login';
import { BrowserSession } from './session';
import { maskEmail } from '../security/ephemeral-login';
import { robustNavigate, formatNavigationFailure } from './navigation';

const logger = getLogger();

export type LoginStatus =
  | 'NOT_TESTED'
  | 'TESTING'
  | 'AUTHENTICATED'
  | 'AUTH_FAILED'
  | 'REGION_BLOCKED';

export type LoginStageName =
  | 'BrowserNavigation'
  | 'LoginPageDetector'
  | 'RegionRestrictionDetector'
  | 'LoginFormDetector'
  | 'CredentialSubmission'
  | 'AuthenticationVerifier'
  | 'SessionPersistence';

export type LoginClassification =
  | 'SUCCESS'
  | 'BROWSER_FAILED'
  | 'NAVIGATION_FAILED'
  | 'REGION_RESTRICTION'
  | 'LOGIN_FORM_UNAVAILABLE'
  | 'INVALID_CREDENTIALS'
  | 'SECURITY_CHALLENGE'
  | 'AUTH_VERIFICATION_FAILED'
  | 'SESSION_PERSISTENCE_FAILED'
  | 'UNKNOWN';

export interface LoginStageResult {
  stage: LoginStageName;
  ok: boolean;
  detail?: string;
  url?: string;
}

export interface LoginTestReport {
  tenantId?: string;
  status: LoginStatus;
  classification: LoginClassification;
  failedStage?: LoginStageName;
  stages: LoginStageResult[];
  maskedEmail?: string;
  finalUrl?: string;
  pageTitle?: string;
  requestedUrl?: string;
  navigationError?: string;
  browser: string;
  session: 'new' | 'restored' | 'active' | 'none';
  authenticated: boolean;
  regionBlocked: boolean;
  action?: string;
  startedAt: string;
  finishedAt: string;
}

export interface LoginTestOptions {
  loginUrl: string;
  email: string;
  password: string;
  tenantId?: string;
  browserSession?: BrowserSession | null;
  context?: BrowserContext | null;
  sessionLabel?: 'new' | 'restored';
}

function actionFor(classification: LoginClassification): string {
  switch (classification) {
    case 'REGION_RESTRICTION':
      return 'Verify deployment IP/region and browser access. Dry-run ACIE can continue without login.';
    case 'BROWSER_FAILED':
      return 'Admin: pin Playwright + Docker image, BROWSER_HEADLESS=true, rebuild --no-cache.';
    case 'NAVIGATION_FAILED':
      return 'Check network, BC_GAME_LOGIN_URL, and outbound access to BC.Game.';
    case 'LOGIN_FORM_UNAVAILABLE':
      return 'Inspect page title/URL; may be region block, challenge, or selector drift.';
    case 'INVALID_CREDENTIALS':
      return 'Verify email/password on BC.Game, then /login again.';
    case 'SECURITY_CHALLENGE':
      return 'Complete CAPTCHA/challenge in an allowed environment, then /login again.';
    case 'AUTH_VERIFICATION_FAILED':
      return 'Credentials may have been accepted but session markers were not detected.';
    case 'SESSION_PERSISTENCE_FAILED':
      return 'Auth looked OK but encrypted session could not be saved — check profile directory permissions.';
    case 'SUCCESS':
      return 'Session ACTIVE. Use /status to verify LOGIN and ACIE independently.';
    default:
      return 'Use /status and Deploy logs. Retry /login after fixing the reported stage.';
  }
}

export async function runLoginTestPipeline(
  page: Page,
  opts: LoginTestOptions
): Promise<LoginTestReport> {
  const startedAt = new Date().toISOString();
  const stages: LoginStageResult[] = [];
  const masked = maskEmail(opts.email);
  let finalUrl = '';
  let password = opts.password;

  const finish = (
    status: LoginStatus,
    classification: LoginClassification,
    failedStage?: LoginStageName,
    extra?: Partial<LoginTestReport>
  ): LoginTestReport => {
    password = '';
    const report: LoginTestReport = {
      tenantId: opts.tenantId,
      status,
      classification,
      failedStage,
      stages,
      maskedEmail: masked,
      finalUrl: finalUrl || undefined,
      browser: 'Chromium',
      session: opts.sessionLabel ?? 'new',
      authenticated: status === 'AUTHENTICATED',
      regionBlocked: classification === 'REGION_RESTRICTION' || status === 'REGION_BLOCKED',
      action: actionFor(classification),
      startedAt,
      finishedAt: new Date().toISOString(),
      ...extra,
    };
    logger.info(
      {
        component: 'LoginTestPipeline',
        status: report.status,
        classification: report.classification,
        failedStage: report.failedStage,
        stages: report.stages.map((s) => `${s.stage}:${s.ok ? 'ok' : 'fail'}`),
      },
      'Login test pipeline finished'
    );
    return report;
  };

  try {
    if (page.isClosed()) {
      stages.push({ stage: 'BrowserNavigation', ok: false, detail: 'PAGE_CLOSED' });
      return finish('AUTH_FAILED', 'BROWSER_FAILED', 'BrowserNavigation');
    }
    const diag = await robustNavigate(page, opts.loginUrl, {
      timeoutMs: 60_000,
      retries: 2,
      waitUntil: 'domcontentloaded',
    });
    finalUrl = diag.finalUrl || page.url();
    if (diag.navigationStatus !== 'ok') {
      const detail = formatNavigationFailure(diag);
      stages.push({
        stage: 'BrowserNavigation',
        ok: false,
        detail: (diag.navigationError || detail).slice(0, 400),
        url: finalUrl,
      });
      return finish('AUTH_FAILED', 'NAVIGATION_FAILED', 'BrowserNavigation', {
        requestedUrl: diag.requestedUrl,
        finalUrl: diag.finalUrl,
        pageTitle: diag.pageTitle,
        navigationError: diag.navigationError,
      });
    }
    stages.push({
      stage: 'BrowserNavigation',
      ok: true,
      detail: `status=${diag.httpStatus ?? 'ok'} title=${(diag.pageTitle || '').slice(0, 60)}`,
      url: finalUrl,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    stages.push({ stage: 'BrowserNavigation', ok: false, detail });
    return finish('AUTH_FAILED', 'NAVIGATION_FAILED', 'BrowserNavigation', {
      navigationError: detail,
      requestedUrl: opts.loginUrl,
      finalUrl: finalUrl || undefined,
    });
  }

  let pageState: string = 'UNKNOWN';
  try {
    const diagnostics = await classifyLoginPage(page, opts.loginUrl);
    finalUrl = diagnostics.finalUrl || page.url();
    pageState = diagnostics.detectedPageState;
    stages.push({ stage: 'LoginPageDetector', ok: true, detail: pageState, url: finalUrl });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    stages.push({ stage: 'LoginPageDetector', ok: false, detail });
    return finish('AUTH_FAILED', 'LOGIN_FORM_UNAVAILABLE', 'LoginPageDetector');
  }

  try {
    const region = await detectRegionRestriction(page);
    if (region.restricted || pageState === 'GEO_RESTRICTED') {
      stages.push({
        stage: 'RegionRestrictionDetector',
        ok: false,
        detail: region.detail ?? 'GEO_RESTRICTED',
        url: region.currentUrl ?? finalUrl,
      });
      return finish('REGION_BLOCKED', 'REGION_RESTRICTION', 'RegionRestrictionDetector');
    }
    stages.push({ stage: 'RegionRestrictionDetector', ok: true, detail: 'not_restricted', url: finalUrl });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    stages.push({ stage: 'RegionRestrictionDetector', ok: false, detail });
  }

  if (pageState === 'SECURITY_CHALLENGE') {
    stages.push({ stage: 'LoginFormDetector', ok: false, detail: 'SECURITY_CHALLENGE', url: finalUrl });
    return finish('AUTH_FAILED', 'SECURITY_CHALLENGE', 'LoginFormDetector');
  }

  if (pageState === 'AUTHENTICATED') {
    stages.push({ stage: 'LoginFormDetector', ok: true, detail: 'ALREADY_AUTHENTICATED', url: finalUrl });
    stages.push({ stage: 'CredentialSubmission', ok: true, detail: 'SKIPPED_ALREADY_AUTH' });
    stages.push({ stage: 'AuthenticationVerifier', ok: true, detail: 'ALREADY_AUTHENTICATED' });
  } else if (pageState !== 'LOGIN_FORM') {
    stages.push({ stage: 'LoginFormDetector', ok: false, detail: `pageState=${pageState}`, url: finalUrl });
    return finish('AUTH_FAILED', 'LOGIN_FORM_UNAVAILABLE', 'LoginFormDetector');
  } else {
    stages.push({ stage: 'LoginFormDetector', ok: true, detail: 'LOGIN_FORM', url: finalUrl });
  }

  if (pageState === 'LOGIN_FORM') {
    try {
      const submit = await submitBcGameLogin(page, opts.email, password, { loginUrl: opts.loginUrl });
      password = '';
      finalUrl = page.url();

      if (submit.regionBlocked) {
        stages.push({ stage: 'CredentialSubmission', ok: false, detail: submit.detail ?? 'REGION_BLOCKED', url: finalUrl });
        return finish('REGION_BLOCKED', 'REGION_RESTRICTION', 'CredentialSubmission');
      }
      if (submit.detail === 'SECURITY_CHALLENGE') {
        stages.push({ stage: 'CredentialSubmission', ok: false, detail: 'SECURITY_CHALLENGE', url: finalUrl });
        return finish('AUTH_FAILED', 'SECURITY_CHALLENGE', 'CredentialSubmission');
      }
      if (!submit.ok && !submit.authenticated) {
        stages.push({ stage: 'CredentialSubmission', ok: false, detail: submit.detail ?? 'AUTH_FAILED', url: finalUrl });
        const classification: LoginClassification =
          submit.detail === 'AUTH_FAILED' || submit.detail === 'AUTH_TIMEOUT'
            ? 'INVALID_CREDENTIALS'
            : submit.detail === 'LOGIN_FORM_UNSTABLE' || submit.detail === 'LOGIN_PAGE_UNKNOWN'
              ? 'LOGIN_FORM_UNAVAILABLE'
              : 'INVALID_CREDENTIALS';
        return finish('AUTH_FAILED', classification, 'CredentialSubmission');
      }
      stages.push({ stage: 'CredentialSubmission', ok: true, detail: submit.detail ?? 'SUBMITTED', url: finalUrl });
    } catch (err) {
      password = '';
      const detail = err instanceof Error ? err.message : String(err);
      stages.push({ stage: 'CredentialSubmission', ok: false, detail });
      return finish('AUTH_FAILED', 'INVALID_CREDENTIALS', 'CredentialSubmission');
    }
  }

  try {
    let verified = pageState === 'AUTHENTICATED';
    if (opts.browserSession) {
      const auth = await opts.browserSession.checkAuthentication(page);
      if (auth.regionBlocked) {
        stages.push({
          stage: 'AuthenticationVerifier',
          ok: false,
          detail: auth.regionDetail ?? auth.detail ?? 'REGION_BLOCKED',
          url: page.url(),
        });
        return finish('REGION_BLOCKED', 'REGION_RESTRICTION', 'AuthenticationVerifier');
      }
      verified = auth.authenticated || verified;
    } else {
      const url = page.url();
      const onLogin = /\/login|\/signin|\/sign-in|\/auth/i.test(url);
      const passCount = await page.locator('input[type="password"]').count().catch(() => 1);
      verified = verified || (!onLogin && passCount === 0);
    }
    if (!verified) {
      stages.push({ stage: 'AuthenticationVerifier', ok: false, detail: 'AUTH_MARKERS_MISSING', url: page.url() });
      return finish('AUTH_FAILED', 'AUTH_VERIFICATION_FAILED', 'AuthenticationVerifier');
    }
    stages.push({ stage: 'AuthenticationVerifier', ok: true, detail: 'AUTHENTICATED', url: page.url() });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    stages.push({ stage: 'AuthenticationVerifier', ok: false, detail });
    return finish('AUTH_FAILED', 'AUTH_VERIFICATION_FAILED', 'AuthenticationVerifier');
  }

  if (opts.browserSession && opts.context) {
    try {
      await opts.browserSession.captureAndSave(opts.context);
      stages.push({ stage: 'SessionPersistence', ok: true, detail: 'SESSION_SAVED' });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      stages.push({ stage: 'SessionPersistence', ok: false, detail });
      return finish('AUTH_FAILED', 'SESSION_PERSISTENCE_FAILED', 'SessionPersistence', { session: 'none' });
    }
  } else {
    stages.push({ stage: 'SessionPersistence', ok: true, detail: 'SKIPPED_NO_SESSION_STORE' });
  }

  return finish('AUTHENTICATED', 'SUCCESS', undefined, { session: 'active' });
}

export function formatLoginTestReport(report: LoginTestReport): string {
  const tenant = report.tenantId ? `#${report.tenantId}` : '—';

  if (report.status === 'AUTHENTICATED' && report.classification === 'SUCCESS') {
    return [
      '🔐 LOGIN TEST',
      '',
      `Tenant: ${tenant}`,
      'Status: SUCCESS',
      '',
      '✓ Login form detected',
      '✓ Credentials submitted',
      '✓ Authentication confirmed',
      '✓ Session established',
      '✓ Persistent browser context created',
      '',
      'Session:',
      'ACTIVE',
      '',
      report.action ?? '',
    ].join('\n');
  }

  const stageLabel = report.failedStage ?? 'Unknown';
  const urlLine = report.finalUrl ? `URL: ${report.finalUrl}` : undefined;
  const requestedLine = report.requestedUrl ? `requestedUrl: ${report.requestedUrl}` : undefined;
  const titleLine = report.pageTitle ? `pageTitle: ${report.pageTitle}` : undefined;
  const navErrLine = report.navigationError ? `error: ${report.navigationError}` : undefined;

  let resultLine = '❌ Login failed';
  switch (report.classification) {
    case 'REGION_RESTRICTION':
      resultLine = '❌ Login form unavailable / region block';
      break;
    case 'INVALID_CREDENTIALS':
      resultLine = '❌ Credentials rejected';
      break;
    case 'LOGIN_FORM_UNAVAILABLE':
      resultLine = '❌ Login form unavailable';
      break;
    case 'BROWSER_FAILED':
      resultLine = '❌ Browser unavailable';
      break;
    case 'NAVIGATION_FAILED':
      resultLine = '❌ Navigation failed (see diagnostics)';
      break;
    case 'SECURITY_CHALLENGE':
      resultLine = '❌ Security challenge required';
      break;
    case 'AUTH_VERIFICATION_FAILED':
      resultLine = '❌ Authentication not confirmed';
      break;
    case 'SESSION_PERSISTENCE_FAILED':
      resultLine = '❌ Session could not be saved';
      break;
    default:
      resultLine = '❌ Login failed';
  }

  const stageHuman: Record<LoginStageName, string> = {
    BrowserNavigation: 'Browser navigation',
    LoginPageDetector: 'Login page detection',
    RegionRestrictionDetector: 'Region restriction check',
    LoginFormDetector: 'Login form detection',
    CredentialSubmission: 'Credential submission',
    AuthenticationVerifier: 'Authentication verification',
    SessionPersistence: 'Session persistence',
  };

  const lines = [
    'LOGIN TEST',
    '',
    `Tenant: ${tenant}`,
    'Status: FAILED',
    '',
    `Stage: ${stageHuman[stageLabel as LoginStageName] ?? stageLabel}`,
  ];
  if (requestedLine) lines.push(requestedLine);
  if (urlLine) lines.push(urlLine);
  if (titleLine) lines.push(titleLine);
  if (navErrLine) lines.push(navErrLine);
  if (report.maskedEmail && report.failedStage === 'CredentialSubmission') {
    lines.push('', `Email: ${report.maskedEmail}`, 'Password: ********');
  }
  lines.push(
    '',
    'Result:',
    resultLine,
    '',
    'Classification:',
    report.classification,
    '',
    'Browser:',
    report.browser,
    `Session: ${report.session}`,
    '',
    'Action:',
    report.action ?? actionFor(report.classification)
  );

  return lines.join('\n');
}
