/**
 * NotificationRouter — central EventBus → Telegram pipeline.
 *
 * System Event
 *      ↓
 * NotificationRouter (config flags, severity routing)
 *      ↓
 * Critical / Health / Routine dispatchers
 *      ↓
 * NotificationQueue (durable buffer + retry)
 *      ↓
 * Telegram delivery
 */

import { randomUUID } from 'crypto';
import { EventBus } from '../core/event-bus/bus.js';
import { SystemEventType } from '../types/events.js';
import { getLogger } from '../observability/logger.js';
import { CriticalDispatcher } from '../telegram/dispatchers/critical.js';
import { HealthDispatcher } from '../telegram/dispatchers/health.js';
import { RoutineDispatcher } from '../telegram/dispatchers/routine.js';
import {
  NotificationPayload,
  NotificationSeverity,
} from '../telegram/types.js';
import { NotificationQueue } from './queue.js';

export interface NotificationRouterConfig {
  sendRoundStart: boolean;
  sendRoundResult: boolean;
  sendHealthWarnings: boolean;
  verbosity: 'quiet' | 'normal' | 'verbose';
}

export interface NotificationRouterOptions {
  eventBus: EventBus;
  critical: CriticalDispatcher;
  health: HealthDispatcher;
  routine: RoutineDispatcher;
  queue: NotificationQueue | null;
  config: NotificationRouterConfig;
}

/** Events we subscribe to for operator notifications */
const SUBSCRIBED_EVENTS: SystemEventType[] = [
  'HealthDegraded',
  'RoundStarted',
  'RoundCrashed',
  'CriticalError',
  'SystemPaused',
  'SystemResumed',
  'BetFailed',
  'CashOutFailed',
  'DailyLimitReached',
];

export class NotificationRouter {
  private readonly logger = getLogger();
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;

  constructor(private readonly options: NotificationRouterOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    const { eventBus } = this.options;

    for (const type of SUBSCRIBED_EVENTS) {
      try {
        const unsub = eventBus.on(type, (event) => {
          void this.handleEvent(type, event as { payload?: Record<string, unknown>; id?: string });
        });
        this.unsubscribers.push(unsub);
      } catch (err) {
        this.logger.warn(
          { component: 'NotificationRouter', type, error: String(err) },
          'Failed to subscribe'
        );
      }
    }

    this.logger.info(
      { component: 'NotificationRouter', events: SUBSCRIBED_EVENTS.length },
      'Notification router started'
    );
  }

  stop(): void {
    for (const u of this.unsubscribers) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.unsubscribers.length = 0;
    this.started = false;
  }

  /**
   * Direct inject for components that already have a payload (e.g. LiveAlerts bridge).
   */
  async notify(payload: NotificationPayload): Promise<void> {
    await this.route(payload);
  }

  private async handleEvent(
    type: string,
    event: { payload?: Record<string, unknown>; id?: string }
  ): Promise<void> {
    const payload = event.payload ?? {};
    const cfg = this.options.config;

    try {
      switch (type) {
        case 'HealthDegraded': {
          if (!cfg.sendHealthWarnings) return;
          const severity = this.mapHealthSeverity(String(payload.status ?? 'warning'));
          await this.route({
            id: event.id ?? randomUUID(),
            severity,
            category: 'health',
            title: `Health: ${String(payload.component ?? 'system')}`,
            message: String(payload.message ?? 'Component degraded'),
            metadata: payload,
            timestamp: new Date().toISOString(),
          });
          break;
        }
        case 'RoundStarted': {
          if (!cfg.sendRoundStart) return;
          await this.route({
            id: event.id ?? randomUUID(),
            severity: 'info',
            category: 'system',
            title: 'Round started',
            message: `Round ${String(payload.roundId ?? '?')} started`,
            metadata: payload,
            timestamp: new Date().toISOString(),
          });
          break;
        }
        case 'RoundCrashed': {
          if (!cfg.sendRoundResult) return;
          const crash = payload.crashPoint ?? payload.multiplier;
          await this.route({
            id: event.id ?? randomUUID(),
            severity: 'info',
            category: 'system',
            title: 'Round result',
            message: `Round ${String(payload.roundId ?? '?')} crashed @ ${String(crash ?? '?')}x`,
            metadata: payload,
            timestamp: new Date().toISOString(),
          });
          break;
        }
        case 'CriticalError':
        case 'BetFailed':
        case 'CashOutFailed':
        case 'DailyLimitReached': {
          await this.route({
            id: event.id ?? randomUUID(),
            severity: type === 'DailyLimitReached' ? 'warning' : 'critical',
            category: 'error',
            title: type,
            message: String(payload.reason ?? payload.message ?? type),
            metadata: payload,
            timestamp: new Date().toISOString(),
          });
          break;
        }
        case 'SystemPaused':
        case 'SystemResumed': {
          if (cfg.verbosity === 'quiet') return;
          await this.route({
            id: event.id ?? randomUUID(),
            severity: 'info',
            category: 'system',
            title: type,
            message: String(payload.reason ?? payload.message ?? type),
            metadata: payload,
            timestamp: new Date().toISOString(),
          });
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.logger.error(
        { component: 'NotificationRouter', type, error: String(err) },
        'Event handling failed'
      );
    }
  }

  private mapHealthSeverity(status: string): NotificationSeverity {
    const s = status.toLowerCase();
    if (s === 'critical' || s === 'failing') return 'critical';
    if (s === 'warning' || s === 'degraded') return 'warning';
    return 'info';
  }

  private async route(payload: NotificationPayload): Promise<void> {
    const { critical, health, routine, queue, config } = this.options;

    try {
      if (payload.severity === 'critical') {
        await critical.dispatch(payload);
        return;
      }

      if (payload.category === 'health' || payload.severity === 'warning') {
        if (!config.sendHealthWarnings && payload.category === 'health') return;
        await health.dispatch(payload);
        return;
      }

      // Routine / info
      if (config.verbosity === 'quiet' && payload.severity === 'info') return;
      await routine.dispatch(payload);
    } catch (err) {
      // Fallback: enqueue for later delivery
      this.logger.error(
        {
          component: 'NotificationRouter',
          notificationId: payload.id,
          error: String(err),
        },
        'Dispatcher failed — enqueueing fallback'
      );
      if (queue) {
        const text = `[${payload.severity.toUpperCase()}] ${payload.title}\n${payload.message}`;
        const priority =
          payload.severity === 'critical'
            ? 'critical'
            : payload.severity === 'warning'
              ? 'high'
              : 'normal';
        queue.enqueue(text, priority as 'critical' | 'high' | 'normal' | 'low');
      }
    }
  }
}
