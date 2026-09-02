/**
 * Operator-driven re-auth protocol (no automated password login — by design).
 * When session auth is lost or too old:
 *  1. System pauses observation/betting
 *  2. High-priority Telegram alert
 *  3. Operator logs in manually in the headed browser (or captures a new profile)
 *  4. Operator sends /reauth_complete
 *  5. System re-validates auth and resumes if OK
 */

import { Page } from 'playwright';
import { getLogger } from '../observability/logger';
import { EventBus } from '../core/event-bus/bus';
import { BrowserSession } from './session';

export type ReauthState = 'idle' | 'awaiting_operator' | 'validating' | 'resolved' | 'failed';

export interface ReauthStatus {
  state: ReauthState;
  reason: string | null;
  requestedAt: string | null;
  resolvedAt: string | null;
}

export class ReauthProtocol {
  private readonly logger = getLogger();
  private state: ReauthState = 'idle';
  private reason: string | null = null;
  private requestedAt: string | null = null;
  private resolvedAt: string | null = null;
  private onPause: (() => Promise<void>) | null = null;
  private onResume: (() => Promise<void>) | null = null;
  private notify: ((message: string) => Promise<void>) | null = null;

  constructor(
    private readonly browserSession: BrowserSession,
    _eventBus?: EventBus
  ) {
    // eventBus reserved for future audit emissions
  }

  setHooks(hooks: {
    onPause?: () => Promise<void>;
    onResume?: () => Promise<void>;
    notify?: (message: string) => Promise<void>;
  }): void {
    this.onPause = hooks.onPause ?? null;
    this.onResume = hooks.onResume ?? null;
    this.notify = hooks.notify ?? null;
  }

  getStatus(): ReauthStatus {
    return {
      state: this.state,
      reason: this.reason,
      requestedAt: this.requestedAt,
      resolvedAt: this.resolvedAt,
    };
  }

  isAwaitingOperator(): boolean {
    return this.state === 'awaiting_operator';
  }

  /**
   * Enter re-auth wait state. Pauses system and alerts operator.
   */
  async requestReauth(reason: string): Promise<void> {
    if (this.state === 'awaiting_operator') return;
    this.state = 'awaiting_operator';
    this.reason = reason;
    this.requestedAt = new Date().toISOString();
    this.resolvedAt = null;

    this.logger.error({ component: 'ReauthProtocol', reason }, 'Re-auth required — system paused');

    if (this.onPause) {
      await this.onPause().catch((err) =>
        this.logger.warn({ component: 'ReauthProtocol', error: String(err) }, 'Pause hook failed')
      );
    }

    const msg =
      `🔐 *Re-authentication required*\n\n` +
      `Reason: ${reason}\n\n` +
      `1. Open the headed browser window\n` +
      `2. Log in to BC.Game manually\n` +
      `3. Confirm the Crash game loads\n` +
      `4. Send /reauth_complete\n\n` +
      `Betting remains paused until auth is confirmed.`;

    if (this.notify) {
      await this.notify(msg).catch(() => undefined);
    }
  }

  /**
   * Operator signals that manual login is complete.
   * Re-checks authentication; resumes only if valid.
   */
  async completeReauth(page: Page): Promise<{ ok: boolean; message: string }> {
    if (this.state !== 'awaiting_operator' && this.state !== 'failed') {
      return { ok: false, message: `Not awaiting re-auth (state=${this.state})` };
    }

    this.state = 'validating';
    this.logger.info({ component: 'ReauthProtocol' }, 'Validating operator re-auth');

    try {
      // Persist via real BrowserSession API when a real Playwright page is available
      try {
        const context = typeof (page as { context?: () => unknown }).context === 'function'
          ? (page as { context: () => unknown }).context()
          : null;
        if (context && typeof this.browserSession.captureAndSave === 'function') {
          await this.browserSession.captureAndSave(context as never).catch((err: unknown) => {
            this.logger.warn(
              { component: 'ReauthProtocol', error: String(err) },
              'Session captureAndSave failed during reauth'
            );
          });
        }
      } catch (err) {
        this.logger.warn(
          { component: 'ReauthProtocol', error: String(err) },
          'Session capture skipped during reauth'
        );
      }

      const auth = await this.browserSession.checkAuthentication(page);
      if (!auth.authenticated) {
        this.state = 'failed';
        return {
          ok: false,
          message:
            'Still not authenticated. Complete login in the browser, then send /reauth_complete again.',
        };
      }

      this.state = 'resolved';
      this.resolvedAt = new Date().toISOString();

      if (this.onResume) {
        await this.onResume().catch((err) =>
          this.logger.warn({ component: 'ReauthProtocol', error: String(err) }, 'Resume hook failed')
        );
      }

      this.logger.info({ component: 'ReauthProtocol' }, 'Re-auth completed successfully');
      return { ok: true, message: 'Authentication confirmed. System may resume.' };
    } catch (err) {
      this.state = 'failed';
      return { ok: false, message: `Validation error: ${String(err)}` };
    }
  }

  reset(): void {
    this.state = 'idle';
    this.reason = null;
    this.requestedAt = null;
    this.resolvedAt = null;
  }
}
