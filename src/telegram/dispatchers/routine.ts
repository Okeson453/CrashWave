/**
 * Telegram Operator Interface — Routine Notification Dispatcher
 *
 * Routine notifications: batched, debounced, verbosity-aware.
 * Respects operator verbosity settings and aggregates non-urgent messages.
 */

import { NotificationPayload, NotificationSeverity } from '../types';
import { ThrottleEngine } from '../throttle';
import { formatBatch } from '../formatters/templates';
import { getLogger } from '../../observability/logger';

const logger = getLogger();

export type VerbosityLevel = 'quiet' | 'normal' | 'verbose' | 'debug';

export interface RoutineDispatcherOptions {
  sendMessage: (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<void>;
  operatorChatIds: number[];
  verbosity: VerbosityLevel;
}

export class RoutineDispatcher {
  private readonly sendMessage: RoutineDispatcherOptions['sendMessage'];
  private readonly operatorChatIds: number[];
  private readonly verbosity: VerbosityLevel;
  private throttleEngine: ThrottleEngine;

  constructor(options: RoutineDispatcherOptions) {
    this.sendMessage = options.sendMessage;
    this.operatorChatIds = options.operatorChatIds;
    this.verbosity = options.verbosity;

    this.throttleEngine = new ThrottleEngine({
      onSend: async (notifications) => {
        await this.deliverBatch(notifications);
      },
      onDrop: (notifications, reason) => {
        logger.debug(
          { component: 'RoutineDispatcher', dropped: notifications.length, reason },
          'Routine notifications dropped'
        );
      },
    });
  }

  /**
   * Dispatch a routine notification. Subject to throttling, batching, and verbosity.
   */
  async dispatch(payload: NotificationPayload): Promise<void> {
    if (!this.shouldSend(payload.severity, payload.category)) {
      logger.debug(
        { component: 'RoutineDispatcher', severity: payload.severity, category: payload.category },
        'Notification filtered by verbosity'
      );
      return;
    }

    await this.throttleEngine.submit(payload);
  }

  /**
   * Force flush any pending routine notifications.
   */
  async flush(): Promise<void> {
    await this.throttleEngine.flushAll();
  }

  /**
   * Stop the dispatcher and drop pending items.
   */
  stop(): void {
    this.throttleEngine.stop();
  }

  private async deliverBatch(notifications: NotificationPayload[]): Promise<void> {
    if (notifications.length === 0) return;

    const formatted = formatBatch(notifications);
    if (!formatted.text) return;

    const results = await Promise.allSettled(
      this.operatorChatIds.map((chatId) =>
        this.sendMessage(chatId, formatted.text, { parse_mode: formatted.parseMode })
      )
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      logger.warn(
        {
          component: 'RoutineDispatcher',
          failedCount: failures.length,
          totalCount: this.operatorChatIds.length,
        },
        'Some routine notifications failed to deliver'
      );
    }
  }

  private shouldSend(severity: NotificationSeverity, category: string): boolean {
    switch (this.verbosity) {
      case 'quiet':
        // Only critical in quiet mode (but critical goes through CriticalDispatcher)
        return false;
      case 'normal':
        return severity !== 'debug' && category !== 'system';
      case 'verbose':
        return severity !== 'debug';
      case 'debug':
        return true;
      default:
        return true;
    }
  }
}
