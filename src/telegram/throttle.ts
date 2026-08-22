/**
 * Telegram Operator Interface — Throttle Engine
 *
 * Rate limiting, debouncing, batching by notification severity.
 * Critical alerts bypass all throttling. Routine notifications
 * are batched and debounced to prevent alert fatigue.
 */

import { getLogger } from '../observability/logger';
import {
  NotificationPayload,
  NotificationSeverity,
  ThrottlePolicy,
  ThrottleState,
  DEFAULT_THROTTLE_POLICIES,
} from './types';

const logger = getLogger();

export interface ThrottleEngineOptions {
  policies?: ThrottlePolicy[];
  onSend: (notifications: NotificationPayload[]) => Promise<void>;
  onDrop?: (notifications: NotificationPayload[], reason: string) => void;
}

export class ThrottleEngine {
  private readonly policies: Map<NotificationSeverity, ThrottlePolicy>;
  private readonly states: Map<NotificationSeverity, ThrottleState>;
  private readonly onSend: (notifications: NotificationPayload[]) => Promise<void>;
  private readonly onDrop?: (notifications: NotificationPayload[], reason: string) => void;
  private stopped: boolean = false;

  constructor(options: ThrottleEngineOptions) {
    this.policies = new Map();
    this.states = new Map();
    this.onSend = options.onSend;
    this.onDrop = options.onDrop;

    const policies = options.policies ?? DEFAULT_THROTTLE_POLICIES;
    for (const policy of policies) {
      this.policies.set(policy.severity, policy);
      this.states.set(policy.severity, {
        count: 0,
        windowStart: Date.now(),
        lastSent: 0,
        pending: [],
        timer: null,
      });
    }
  }

  /**
   * Submit a notification for potential delivery.
   * Critical notifications are sent immediately.
   * Others are subject to rate limiting, debouncing, and batching.
   */
  async submit(notification: NotificationPayload): Promise<void> {
    if (this.stopped) {
      this.onDrop?.([notification], 'engine_stopped');
      return;
    }

    const policy = this.policies.get(notification.severity);
    if (!policy) {
      logger.warn(
        { component: 'ThrottleEngine', severity: notification.severity },
        'No policy for severity, dropping'
      );
      this.onDrop?.([notification], 'no_policy');
      return;
    }

    // Critical bypasses everything
    if (notification.severity === 'critical') {
      await this.deliverImmediate(notification);
      return;
    }

    const state = this.states.get(notification.severity)!;

    // Check rate limits
    if (!this.checkRateLimit(state, policy)) {
      this.onDrop?.([notification], 'rate_limited');
      return;
    }

    // Add to pending
    state.pending.push(notification);

    // Debounce / batch logic
    if (policy.debounceMs === 0 && policy.batchWindowMs === 0) {
      // Immediate delivery for this severity
      await this.flush(notification.severity);
    } else {
      this.scheduleFlush(notification.severity, policy);
    }
  }

  /**
   * Force flush all pending notifications regardless of debounce.
   */
  async flushAll(): Promise<void> {
    for (const severity of this.states.keys()) {
      await this.flush(severity);
    }
  }

  /**
   * Stop the engine and drop any pending notifications.
   */
  stop(): void {
    this.stopped = true;
    for (const state of this.states.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.pending.length > 0) {
        this.onDrop?.(state.pending, 'engine_stopped');
        state.pending = [];
      }
    }
  }

  /**
   * Get current pending counts per severity.
   */
  getPendingCounts(): Record<NotificationSeverity, number> {
    const counts: Partial<Record<NotificationSeverity, number>> = {};
    for (const [severity, state] of this.states) {
      counts[severity] = state.pending.length;
    }
    return counts as Record<NotificationSeverity, number>;
  }

  private async deliverImmediate(notification: NotificationPayload): Promise<void> {
    try {
      await this.onSend([notification]);
      const state = this.states.get('critical')!;
      state.count++;
      state.lastSent = Date.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { component: 'ThrottleEngine', notificationId: notification.id, error: message },
        'Critical notification delivery failed'
      );
      throw error; // Critical failures must be retried by caller
    }
  }

  private scheduleFlush(severity: NotificationSeverity, policy: ThrottlePolicy): void {
    const state = this.states.get(severity)!;

    if (state.timer) {
      // Timer already scheduled
      return;
    }

    const delay = Math.max(policy.debounceMs, policy.batchWindowMs);
    state.timer = setTimeout(() => {
      state.timer = null;
      this.flush(severity).catch((err) => {
        logger.error(
          { component: 'ThrottleEngine', severity, error: String(err) },
          'Scheduled flush failed'
        );
      });
    }, delay);
  }

  private async flush(severity: NotificationSeverity): Promise<void> {
    const state = this.states.get(severity)!;
    if (state.pending.length === 0) return;

    const batch = [...state.pending];
    state.pending = [];

    // Deduplicate if policy says so
    const policy = this.policies.get(severity)!;
    const toSend = policy.dropDuplicates ? this.deduplicate(batch) : batch;

    if (toSend.length === 0) return;

    try {
      await this.onSend(toSend);
      state.count += toSend.length;
      state.lastSent = Date.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { component: 'ThrottleEngine', severity, count: toSend.length, error: message },
        'Batch delivery failed'
      );
      // Re-queue for retry? For now, drop to avoid loops
      this.onDrop?.(toSend, `delivery_failed: ${message}`);
    }
  }

  private checkRateLimit(state: ThrottleState, policy: ThrottlePolicy): boolean {
    const now = Date.now();
    const hourWindow = 3600000;

    // Reset window if expired
    if (now - state.windowStart > hourWindow) {
      state.count = 0;
      state.windowStart = now;
    }

    const totalInFlight = state.count + state.pending.length;

    // Per-minute check (sliding window approximation)
    const minuteCount = this.approximateMinuteCount(state, now) + state.pending.length;
    if (minuteCount >= policy.maxPerMinute) {
      return false;
    }

    // Per-hour check
    if (totalInFlight >= policy.maxPerHour) {
      return false;
    }

    return true;
  }

  private approximateMinuteCount(state: ThrottleState, now: number): number {
    // Simple approximation: if last sent was within a minute, assume active
    const minuteAgo = now - 60000;
    if (state.lastSent > minuteAgo) {
      // Rough estimate: assume uniform distribution
      return Math.min(state.count, Math.ceil((state.count * 60000) / Math.max(now - state.windowStart, 60000)));
    }
    return 0;
  }

  private deduplicate(notifications: NotificationPayload[]): NotificationPayload[] {
    const seen = new Set<string>();
    const result: NotificationPayload[] = [];

    for (const n of notifications) {
      const key = `${n.category}:${n.title}:${n.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(n);
      }
    }

    return result;
  }
}
