/**
 * Telegram Operator Interface — Critical Alert Dispatcher
 *
 * Critical alerts bypass throttling, use immediate delivery,
 * and retry on failure. These are the highest-priority notifications
 * that demand operator attention.
 */

import { NotificationPayload } from '../types';
import { RealTimeNotificationFormatter } from '../formatters/notifications';
import { getLogger } from '../../observability/logger';

const logger = getLogger();

export interface CriticalDispatcherOptions {
  sendMessage: (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<void>;
  operatorChatIds: number[];
  maxRetries?: number;
  retryDelayMs?: number;
  /** Called when all retries fail — e.g. enqueue to NotificationQueue */
  onDeliveryFailure?: (payload: NotificationPayload, formattedText: string) => void;
}

export class CriticalDispatcher {
  private readonly sendMessage: CriticalDispatcherOptions['sendMessage'];
  private readonly operatorChatIds: number[];
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly formatter = new RealTimeNotificationFormatter();
  private inFlight = new Set<string>();

  private readonly onDeliveryFailure?: CriticalDispatcherOptions['onDeliveryFailure'];

  constructor(options: CriticalDispatcherOptions) {
    this.sendMessage = options.sendMessage;
    this.operatorChatIds = options.operatorChatIds;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 2000;
    this.onDeliveryFailure = options.onDeliveryFailure;
  }

  /**
   * Dispatch a critical alert immediately to all operators.
   * Retries on failure with exponential backoff.
   */
  async dispatch(payload: NotificationPayload): Promise<void> {
    if (payload.severity !== 'critical') {
      logger.warn(
        { component: 'CriticalDispatcher', notificationId: payload.id },
        'Non-critical notification routed to critical dispatcher'
      );
    }

    if (this.inFlight.has(payload.id)) {
      logger.debug(
        { component: 'CriticalDispatcher', notificationId: payload.id },
        'Duplicate critical dispatch skipped'
      );
      return;
    }

    this.inFlight.add(payload.id);

    try {
      const formatted = this.formatter.format(payload);

      // Send to all operators in parallel
      const results = await Promise.allSettled(
        this.operatorChatIds.map((chatId) =>
          this.sendWithRetry(chatId, formatted.text, { parse_mode: formatted.parseMode })
        )
      );

      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        logger.error(
          {
            component: 'CriticalDispatcher',
            notificationId: payload.id,
            failedCount: failures.length,
            totalCount: this.operatorChatIds.length,
          },
          'Some critical alerts failed to deliver'
        );
        // Persistent fallback when every operator delivery failed
        if (failures.length === this.operatorChatIds.length && this.onDeliveryFailure) {
          try {
            this.onDeliveryFailure(payload, formatted.text);
          } catch {
            /* ignore fallback errors */
          }
        }
      } else {
        logger.info(
          { component: 'CriticalDispatcher', notificationId: payload.id },
          'Critical alert delivered to all operators'
        );
      }
    } finally {
      this.inFlight.delete(payload.id);
    }
  }

  private async sendWithRetry(
    chatId: number,
    text: string,
    extra: Record<string, unknown>
  ): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.sendMessage(chatId, text, extra);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * Math.pow(2, attempt);
          logger.warn(
            {
              component: 'CriticalDispatcher',
              chatId,
              attempt: attempt + 1,
              maxRetries: this.maxRetries,
              delay,
              error: lastError.message,
            },
            'Critical delivery failed, retrying'
          );
          await sleep(delay);
        }
      }
    }

    throw lastError;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
