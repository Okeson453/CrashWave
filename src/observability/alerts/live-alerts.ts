import { EventBus, getEventBus } from '../../core/event-bus/bus';
import { getLogger } from '../logger';
import { SystemHealthReport } from '../health/live-checks';
import { ReconciliationResult } from '../../ledger/balance-reconciliation';
import { RecoveryResult } from '../../core/recovery-manager';
import { EmergencyStopResult } from '../../core/emergency-stop';

/**
 * Severity level for an alert.
 */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/**
 * A single alert notification.
 */
export interface AlertNotification {
  id: string;
  severity: AlertSeverity;
  component: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
  acknowledged: boolean;
}

/**
 * Configuration for live alerts.
 */
export interface LiveAlertConfig {
  /** Max alerts to keep in memory */
  maxAlertHistory: number;
  /** Whether to deduplicate identical alerts within this window (ms) */
  deduplicationWindowMs: number;
  /** Whether to emit alert events to the event bus */
  emitToEventBus: boolean;
  /** Rate limit: max alerts per minute */
  rateLimitPerMinute: number;
}

const DEFAULT_ALERT_CONFIG: LiveAlertConfig = {
  maxAlertHistory: 500,
  deduplicationWindowMs: 60000,
  emitToEventBus: true,
  rateLimitPerMinute: 30,
};

/**
 * LiveAlerts is the central alerting hub for the live execution system.
 * It receives health reports, reconciliation results, recovery outcomes,
 * and emergency stop events, and generates actionable alert notifications.
 *
 * Features:
 *   - Severity classification (info / warning / critical).
 *   - Deduplication of repeated alerts.
 *   - Rate limiting to prevent alert storms.
 *   - Acknowledgement tracking for operator workflow.
 *   - Event bus integration for downstream notification channels (Telegram, email, etc.).
 */
export class LiveAlerts {
  private readonly logger = getLogger();
  private readonly config: LiveAlertConfig;
  private readonly alertHistory: AlertNotification[] = [];
  private readonly recentAlertKeys = new Map<string, number>();
  private alertCountThisMinute = 0;
  private rateLimitWindowStart = Date.now();

  constructor(
    private readonly eventBus: EventBus = getEventBus(),
    config?: Partial<LiveAlertConfig>
  ) {
    this.config = { ...DEFAULT_ALERT_CONFIG, ...config };
  }

  /**
   * Returns all alerts in chronological order (newest last).
   */
  getAlertHistory(): readonly AlertNotification[] {
    return this.alertHistory;
  }

  /**
   * Returns only unacknowledged alerts.
   */
  getUnacknowledgedAlerts(): AlertNotification[] {
    return this.alertHistory.filter((a) => !a.acknowledged);
  }

  /**
   * Returns only critical alerts.
   */
  getCriticalAlerts(): AlertNotification[] {
    return this.alertHistory.filter((a) => a.severity === 'critical');
  }

  /**
   * Acknowledges an alert by ID.
   */
  acknowledgeAlert(alertId: string): boolean {
    const alert = this.alertHistory.find((a) => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      this.logger.info({ component: 'LiveAlerts', alertId }, 'Alert acknowledged');
      return true;
    }
    return false;
  }

  /**
   * Clears all alert history.
   */
  clearHistory(): void {
    this.alertHistory.length = 0;
    this.recentAlertKeys.clear();
    this.alertCountThisMinute = 0;
    this.logger.info({ component: 'LiveAlerts' }, 'Alert history cleared');
  }

  /**
   * Processes a system health report and generates alerts for any
   * degraded or critical components.
   */
  async onHealthReport(report: SystemHealthReport): Promise<void> {
    if (report.overall === 'healthy') {
      return;
    }

    for (const component of report.components) {
      if (component.status === 'degraded') {
        await this.sendAlert({
          severity: 'warning',
          component: component.component,
          message: component.message,
          details: { latencyMs: component.latencyMs },
        });
      } else if (component.status === 'critical') {
        await this.sendAlert({
          severity: 'critical',
          component: component.component,
          message: component.message,
          details: { latencyMs: component.latencyMs },
        });
      }
    }

    if (report.unknownBets > 0) {
      await this.sendAlert({
        severity: 'warning',
        component: 'bet-state',
        message: `${report.unknownBets} bet(s) in UNKNOWN state`,
        details: { unknownBets: report.unknownBets, activeBets: report.activeBets },
      });
    }
  }

  /**
   * Processes a balance reconciliation result and alerts on mismatch.
   */
  async onReconciliationResult(result: ReconciliationResult): Promise<void> {
    if (!result.reconciled) {
      const severity = Math.abs(result.difference) >= 100 ? 'critical' : 'warning';
      await this.sendAlert({
        severity,
        component: 'balance-reconciliation',
        message: `Balance mismatch: expected ${result.expectedBalance}, actual ${result.actualBalance}, diff ${result.difference}`,
        details: {
          expectedBalance: result.expectedBalance,
          actualBalance: result.actualBalance,
          difference: result.difference,
          tolerance: result.tolerance,
          unresolvedBets: result.unresolvedBets,
        },
      });
    }
  }

  /**
   * Processes a recovery result and alerts on incomplete recovery.
   */
  async onRecoveryResult(result: RecoveryResult): Promise<void> {
    if (!result.canResume) {
      await this.sendAlert({
        severity: 'critical',
        component: 'recovery-manager',
        message: `Recovery incomplete — betting remains halted. Errors: ${result.errors.join('; ')}`,
        details: {
          phase: result.phase,
          errors: result.errors,
          unknownBetsRemaining: result.betRecovery?.stillUnknown ?? 0,
        },
      });
    } else if (result.betRecovery && result.betRecovery.totalUnknown > 0) {
      await this.sendAlert({
        severity: 'info',
        component: 'recovery-manager',
        message: `Recovery complete: ${result.betRecovery.resolved} of ${result.betRecovery.totalUnknown} UNKNOWN bets resolved`,
        details: {
          resolved: result.betRecovery.resolved,
          manualReviewRequired: result.betRecovery.manualReviewRequired,
        },
      });
    }
  }

  /**
   * Processes an emergency stop result and alerts immediately.
   */
  async onEmergencyStop(result: EmergencyStopResult): Promise<void> {
    await this.sendAlert({
      severity: 'critical',
      component: 'emergency-stop',
      message: `EMERGENCY STOP triggered: ${result.reason}`,
      details: {
        haltedExecutors: result.haltedExecutors,
        cancelledPendingBets: result.cancelledPendingBets,
        preservedState: result.preservedState,
        operatorNotified: result.operatorNotified,
      },
    });
  }

  /**
   * Sends a generic alert. This is the low-level entry-point.
   */
  async sendAlert(params: {
    severity: AlertSeverity;
    component: string;
    message: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    // Rate limiting
    this.pruneRateLimit();
    if (this.alertCountThisMinute >= this.config.rateLimitPerMinute) {
      this.logger.warn(
        { component: 'LiveAlerts', message: params.message },
        'Alert rate limit exceeded — dropping alert'
      );
      return;
    }

    // Deduplication
    const dedupKey = `${params.severity}|${params.component}|${params.message}`;
    const now = Date.now();
    const lastSent = this.recentAlertKeys.get(dedupKey);
    if (lastSent && now - lastSent < this.config.deduplicationWindowMs) {
      this.logger.debug(
        { component: 'LiveAlerts', dedupKey },
        'Duplicate alert suppressed'
      );
      return;
    }

    const alert: AlertNotification = {
      id: `alert-${now}-${Math.random().toString(36).slice(2, 8)}`,
      severity: params.severity,
      component: params.component,
      message: params.message,
      details: params.details,
      timestamp: new Date().toISOString(),
      acknowledged: false,
    };

    this.alertHistory.push(alert);
    if (this.alertHistory.length > this.config.maxAlertHistory) {
      this.alertHistory.shift();
    }

    this.recentAlertKeys.set(dedupKey, now);
    this.alertCountThisMinute++;

    // Log at appropriate level
    const logPayload = {
      component: 'LiveAlerts',
      alertId: alert.id,
      severity: alert.severity,
      componentName: alert.component,
      ...alert.details,
    };

    if (alert.severity === 'critical') {
      this.logger.error(logPayload, alert.message);
    } else if (alert.severity === 'warning') {
      this.logger.warn(logPayload, alert.message);
    } else {
      this.logger.info(logPayload, alert.message);
    }

    // Emit to event bus for downstream channels
    if (this.config.emitToEventBus) {
      await this.eventBus.emitTyped('HealthDegraded', {
        component: alert.component,
        status: alert.severity,
        message: alert.message,
      }, alert.id, 'LiveAlerts');
    }
  }

  private pruneRateLimit(): void {
    const now = Date.now();
    if (now - this.rateLimitWindowStart >= 60000) {
      this.alertCountThisMinute = 0;
      this.rateLimitWindowStart = now;
      this.pruneRecentAlertKeys(now);
    }
  }

  /** Drop dedup keys older than 10 minutes to bound memory on long runs */
  private pruneRecentAlertKeys(now = Date.now()): void {
    const maxAgeMs = 10 * 60 * 1000;
    for (const [key, ts] of this.recentAlertKeys.entries()) {
      if (now - ts > maxAgeMs) {
        this.recentAlertKeys.delete(key);
      }
    }
  }
}
