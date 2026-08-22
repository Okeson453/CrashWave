/**
 * Telegram Operator Interface — Health Warning Dispatcher
 *
 * Health warnings: debounced to prevent alert spam.
 * Similar components are grouped and only the latest state is reported.
 */

import { NotificationPayload } from '../types';
import { ThrottleEngine } from '../throttle';
import { formatHealthWarning } from '../formatters/templates';
import { getLogger } from '../../observability/logger';

const logger = getLogger();

export interface HealthDispatcherOptions {
  sendMessage: (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<void>;
  operatorChatIds: number[];
  debounceMs?: number;
}

export class HealthDispatcher {
  private readonly sendMessage: HealthDispatcherOptions['sendMessage'];
  private readonly operatorChatIds: number[];
  private readonly debounceMs: number;
  private throttleEngine: ThrottleEngine;
  private lastComponentState = new Map<string, { status: string; timestamp: number }>();

  constructor(options: HealthDispatcherOptions) {
    this.sendMessage = options.sendMessage;
    this.operatorChatIds = options.operatorChatIds;
    this.debounceMs = options.debounceMs ?? 30000;

    this.throttleEngine = new ThrottleEngine({
      policies: [
        {
          severity: 'warning',
          maxPerMinute: 5,
          maxPerHour: 50,
          debounceMs: this.debounceMs,
          batchWindowMs: this.debounceMs,
          dropDuplicates: true,
        },
      ],
      onSend: async (notifications) => {
        await this.deliverBatch(notifications);
      },
      onDrop: (notifications, reason) => {
        logger.debug(
          { component: 'HealthDispatcher', dropped: notifications.length, reason },
          'Health notifications dropped'
        );
      },
    });
  }

  /**
   * Dispatch a health warning. Debounced to prevent spam.
   * If the same component reports the same status repeatedly, only the
   * first occurrence within the debounce window is sent.
   */
  async dispatch(payload: NotificationPayload): Promise<void> {
    const component = String(payload.metadata?.component ?? 'unknown');
    const status = String(payload.metadata?.status ?? 'unknown');

    // Check if this is a duplicate state for this component
    const last = this.lastComponentState.get(component);
    const now = Date.now();

    if (last && last.status === status && now - last.timestamp < this.debounceMs) {
      logger.debug(
        { component: 'HealthDispatcher', healthComponent: component, status },
        'Duplicate health state suppressed'
      );
      return;
    }

    this.lastComponentState.set(component, { status, timestamp: now });

    await this.throttleEngine.submit(payload);
  }

  /**
   * Force flush any pending health notifications.
   */
  async flush(): Promise<void> {
    await this.throttleEngine.flushAll();
  }

  /**
   * Stop the dispatcher.
   */
  stop(): void {
    this.throttleEngine.stop();
  }

  /**
   * Clear the component state cache (useful after recovery).
   */
  clearCache(): void {
    this.lastComponentState.clear();
  }

  private async deliverBatch(notifications: NotificationPayload[]): Promise<void> {
    if (notifications.length === 0) return;

    // For health, we prefer individual messages unless there are many
    if (notifications.length === 1) {
      const n = notifications[0];
      const formatted = formatHealthWarning({
        component: String(n.metadata?.component ?? 'unknown'),
        status: String(n.metadata?.status ?? 'unknown'),
        message: n.message,
      });

      await Promise.allSettled(
        this.operatorChatIds.map((chatId) =>
          this.sendMessage(chatId, formatted.text, { parse_mode: formatted.parseMode })
        )
      );
      return;
    }

    // Multiple health issues: batch them
    const lines = ['💓 *Health Warnings*', ''];
    for (const n of notifications) {
      const comp = String(n.metadata?.component ?? 'unknown');
      const status = String(n.metadata?.status ?? 'unknown');
      lines.push(`• *${comp}*: ${status}`);
    }

    const text = lines.join('\n');
    await Promise.allSettled(
      this.operatorChatIds.map((chatId) =>
        this.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' })
      )
    );
  }
}
