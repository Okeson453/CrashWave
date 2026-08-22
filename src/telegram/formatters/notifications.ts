/**
 * Telegram Operator Interface — Real-time Notification Formatters
 *
 * Converts system events into human-readable Telegram messages.
 * Covers: wins, losses, errors, health warnings, milestones.
 */

import {
  NotificationPayload,
  NotificationSeverity,
  NotificationCategory,
} from '../types';
import {
  formatNotification,
  formatWin,
  formatLoss,
  formatCriticalError,
  formatHealthWarning,
  formatMilestone,
  FormattedMessage,
} from './templates';
import { getLogger } from '../../observability/logger';

const logger = getLogger();

export interface NotificationFormatter {
  format(payload: NotificationPayload): FormattedMessage;
}

/**
 * Real-time notification formatter that maps system events to Telegram messages.
 */
export class RealTimeNotificationFormatter implements NotificationFormatter {
  format(payload: NotificationPayload): FormattedMessage {
    logger.debug(
      { component: 'NotificationFormatter', category: payload.category, severity: payload.severity },
      'Formatting notification'
    );

    switch (payload.category) {
      case 'win':
        return this.formatWin(payload);
      case 'loss':
        return this.formatLoss(payload);
      case 'error':
        return this.formatError(payload);
      case 'health':
        return this.formatHealth(payload);
      case 'milestone':
        return this.formatMilestone(payload);
      case 'system':
      case 'config':
      default:
        return formatNotification(payload);
    }
  }

  private formatWin(payload: NotificationPayload): FormattedMessage {
    const meta = payload.metadata ?? {};
    return formatWin({
      betId: String(meta.betId ?? 'unknown'),
      roundId: String(meta.roundId ?? 'unknown'),
      stake: Number(meta.stake ?? 0),
      cashOutMultiplier: Number(meta.cashOutMultiplier ?? 0),
      pnl: Number(meta.pnl ?? 0),
    });
  }

  private formatLoss(payload: NotificationPayload): FormattedMessage {
    const meta = payload.metadata ?? {};
    return formatLoss({
      betId: String(meta.betId ?? 'unknown'),
      roundId: String(meta.roundId ?? 'unknown'),
      stake: Number(meta.stake ?? 0),
      crashPoint: Number(meta.crashPoint ?? 0),
      pnl: Number(meta.pnl ?? 0),
    });
  }

  private formatError(payload: NotificationPayload): FormattedMessage {
    const meta = payload.metadata ?? {};

    if (payload.severity === 'critical') {
      return formatCriticalError({
        message: payload.message,
        code: String(meta.code ?? 'UNKNOWN'),
        component: String(meta.component ?? 'unknown'),
      });
    }

    return formatNotification(payload);
  }

  private formatHealth(payload: NotificationPayload): FormattedMessage {
    const meta = payload.metadata ?? {};
    return formatHealthWarning({
      component: String(meta.component ?? 'unknown'),
      status: String(meta.status ?? 'unknown'),
      message: payload.message,
    });
  }

  private formatMilestone(payload: NotificationPayload): FormattedMessage {
    const meta = payload.metadata ?? {};
    return formatMilestone({
      milestone: payload.title,
      value: String(meta.value ?? ''),
      context: payload.message,
    });
  }
}

/**
 * Factory to create a notification payload from system events.
 */
export function createNotificationPayload(
  severity: NotificationSeverity,
  category: NotificationCategory,
  title: string,
  message: string,
  metadata?: Record<string, unknown>
): NotificationPayload {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    severity,
    category,
    title,
    message,
    metadata,
    timestamp: new Date().toISOString(),
  };
}
