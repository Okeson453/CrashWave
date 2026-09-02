/**
 * Account-linking protection monitor.
 * Ensures one profile + one sticky proxy + one process identity remain consistent.
 * Architectural isolation is enforced; this actively detects drift and alerts.
 */

import { getLogger } from '../observability/logger';
import { EventBus, getEventBus } from '../core/event-bus/bus';
import { metricCollector } from '../observability/metrics/collectors';

export interface AccountLinkSnapshot {
  profileId: string;
  proxyServer: string | null;
  stickySessionId: string | null;
  instanceId: string;
  startedAt: string;
}

export interface AccountLinkViolation {
  kind: 'profile_changed' | 'proxy_changed' | 'sticky_session_changed' | 'instance_conflict';
  detail: string;
  detectedAt: string;
}

export class AccountLinkMonitor {
  private readonly logger = getLogger();
  private readonly eventBus: EventBus;
  private baseline: AccountLinkSnapshot | null = null;
  private violations: AccountLinkViolation[] = [];

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus ?? getEventBus();
  }

  /** Establish the single allowed identity for this process lifetime */
  bind(snapshot: AccountLinkSnapshot): void {
    if (this.baseline) {
      this.logger.warn(
        { component: 'AccountLinkMonitor' },
        'Account link baseline already set — ignoring re-bind'
      );
      return;
    }
    this.baseline = { ...snapshot };
    this.logger.info(
      {
        component: 'AccountLinkMonitor',
        profileId: snapshot.profileId,
        proxy: snapshot.proxyServer ? 'set' : 'none',
        sticky: snapshot.stickySessionId ? 'yes' : 'no',
      },
      'Account link baseline established'
    );
  }

  getBaseline(): AccountLinkSnapshot | null {
    return this.baseline ? { ...this.baseline } : null;
  }

  /**
   * Validate current identity matches baseline.
   * Returns null if OK, otherwise a violation record.
   */
  check(current: Partial<AccountLinkSnapshot>): AccountLinkViolation | null {
    if (!this.baseline) return null;

    if (current.profileId && current.profileId !== this.baseline.profileId) {
      return this.raise('profile_changed', `Profile ${this.baseline.profileId} → ${current.profileId}`);
    }
    if (
      current.proxyServer !== undefined &&
      current.proxyServer !== this.baseline.proxyServer
    ) {
      return this.raise(
        'proxy_changed',
        `Proxy drift: ${this.baseline.proxyServer ?? 'none'} → ${current.proxyServer ?? 'none'}`
      );
    }
    if (
      current.stickySessionId !== undefined &&
      this.baseline.stickySessionId &&
      current.stickySessionId !== this.baseline.stickySessionId
    ) {
      return this.raise(
        'sticky_session_changed',
        `Sticky session changed mid-run (account-link risk)`
      );
    }
    if (current.instanceId && current.instanceId !== this.baseline.instanceId) {
      return this.raise(
        'instance_conflict',
        `Instance ID mismatch: ${this.baseline.instanceId} vs ${current.instanceId}`
      );
    }
    return null;
  }

  getViolations(): AccountLinkViolation[] {
    return [...this.violations];
  }

  private raise(
    kind: AccountLinkViolation['kind'],
    detail: string
  ): AccountLinkViolation {
    const v: AccountLinkViolation = {
      kind,
      detail,
      detectedAt: new Date().toISOString(),
    };
    this.violations.push(v);
    this.logger.error({ component: 'AccountLinkMonitor', ...v }, 'Account-link violation');
    try {
      (metricCollector as any).increment?.('account_link_violation_total', { kind });
    } catch {
      /* optional */
    }
    void this.eventBus
      .emitTyped?.(
        'CriticalError' as never,
        { component: 'AccountLinkMonitor', message: detail, kind },
        'account-link',
        'system'
      )
      .catch(() => undefined);
    return v;
  }
}
