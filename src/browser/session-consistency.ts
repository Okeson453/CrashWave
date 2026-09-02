/**
 * Session consistency — auth validation and age checks.
 */

import { Page } from 'playwright';
import { SessionConsistencyConfig } from '../config/schema';
import { BrowserSession } from './session';
import { getLogger } from '../observability/logger';
import { EventBus } from '../core/event-bus/bus';
import { metricCollector } from '../observability/metrics/collectors';

export class SessionConsistencyManager {
  private readonly logger = getLogger();

  constructor(
    private readonly config: SessionConsistencyConfig,
    private readonly browserSession: BrowserSession,
    _eventBus?: EventBus
  ) {
    // eventBus reserved for future CriticalError emissions
  }

  async validateOnStart(page: Page): Promise<{ ok: boolean; reason?: string }> {
    if (!this.config.requireAuthOnStart) {
      return { ok: true };
    }

    try {
      const auth = await this.browserSession.checkAuthentication(page as never);
      if (!auth || auth.authenticated === false) {
        this.logger.error({ component: 'SessionConsistency' }, 'Session not authenticated on start');
        (metricCollector as any).recordSessionConsistencyFailure?.('not_authenticated');
        return { ok: false, reason: 'not_authenticated' };
      }
    } catch (err) {
      this.logger.error(
        { component: 'SessionConsistency', error: String(err) },
        'Auth check failed on start — fail closed'
      );
      (metricCollector as any).recordSessionConsistencyFailure?.('auth_check_failed');
      if (this.config.requireAuthOnStart) {
        return { ok: false, reason: 'auth_check_failed' };
      }
    }

    const state = this.browserSession.getCurrentState?.();
    if (state?.timestamp) {
      const ageHours = (Date.now() - new Date(state.timestamp).getTime()) / 3_600_000;
      if (ageHours > this.config.maxSessionAgeHours) {
        this.logger.warn({ component: 'SessionConsistency', ageHours }, 'Session age exceeded');
        (metricCollector as any).recordSessionConsistencyFailure?.('session_too_old');
        return { ok: false, reason: 'session_too_old' };
      }
    }

    return { ok: true };
  }

  async monitorAuthLoss(page: Page, onLoss: () => Promise<void>): Promise<void> {
    if (!this.config.pauseOnAuthLoss) return;
    try {
      const auth = await this.browserSession.checkAuthentication?.(page);
      if (auth && !auth.authenticated) {
        this.logger.error({ component: 'SessionConsistency' }, 'Authentication lost during session');
        (metricCollector as any).recordSessionConsistencyFailure?.('auth_loss');
        await onLoss();
      }
    } catch (err) {
      this.logger.debug({ component: 'SessionConsistency', error: String(err) }, 'Auth monitor error');
    }
  }
}
