/**
 * NotificationQueue buffers notifications when the primary channel is unavailable.
 * Implements background flush with exponential backoff and a simple dead-letter queue.
 */

import { getLogger } from '../observability/logger';

export interface QueuedMessage {
  id: string;
  message: string;
  priority: string;
  attempts: number;
  enqueuedAt: number;
  lastAttemptAt?: number;
}

export interface NotificationQueueOptions {
  maxSize: number;
  flushIntervalMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  /** Optional delivery function; when provided, flush will call it */
  deliver?: (message: string, priority: string) => Promise<boolean>;
  onDeadLetter?: (item: QueuedMessage) => void;
}

export interface QueueMetrics {
  depth: number;
  deadLetterDepth: number;
  enqueued: number;
  delivered: number;
  failed: number;
  deadLettered: number;
}

export class NotificationQueue {
  private readonly maxSize: number;
  private readonly flushIntervalMs: number;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly deliver?: (message: string, priority: string) => Promise<boolean>;
  private readonly onDeadLetter?: (item: QueuedMessage) => void;
  private readonly logger = getLogger();

  private queue: QueuedMessage[] = [];
  private deadLetter: QueuedMessage[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private destroyed = false;

  private metrics = {
    enqueued: 0,
    delivered: 0,
    failed: 0,
    deadLettered: 0,
  };

  private idCounter = 0;

  constructor(options: NotificationQueueOptions) {
    this.maxSize = options.maxSize;
    this.flushIntervalMs = options.flushIntervalMs;
    this.retryAttempts = options.retryAttempts;
    this.retryDelayMs = options.retryDelayMs;
    this.deliver = options.deliver;
    this.onDeadLetter = options.onDeadLetter;

    if (this.flushIntervalMs > 0 && this.deliver) {
      this.startFlushLoop();
    }
  }

  private nextId(): string {
    this.idCounter += 1;
    return `nq-${Date.now()}-${this.idCounter}`;
  }

  enqueue(message: string, priority = 'normal'): void {
    if (this.destroyed) return;

    if (this.queue.length >= this.maxSize) {
      // Drop oldest low-priority first
      const lowIdx = this.queue.findIndex((m) => m.priority === 'low' || m.priority === 'normal');
      if (lowIdx >= 0) {
        this.queue.splice(lowIdx, 1);
      } else {
        this.queue.shift();
      }
      this.logger.warn({ component: 'NotificationQueue' }, 'Queue full — dropped oldest message');
    }

    this.queue.push({
      id: this.nextId(),
      message,
      priority,
      attempts: 0,
      enqueuedAt: Date.now(),
    });
    this.metrics.enqueued++;

    // Priority sort: critical > high > normal > low
    const order: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
    this.queue.sort(
      (a, b) => (order[a.priority] ?? 2) - (order[b.priority] ?? 2)
    );
  }

  dequeue(): { message: string; priority: string } | null {
    const item = this.queue.shift();
    if (!item) return null;
    return { message: item.message, priority: item.priority };
  }

  size(): number {
    return this.queue.length;
  }

  deadLetterSize(): number {
    return this.deadLetter.length;
  }

  getDeadLetter(): ReadonlyArray<QueuedMessage> {
    return this.deadLetter;
  }

  getMetrics(): QueueMetrics {
    return {
      depth: this.queue.length,
      deadLetterDepth: this.deadLetter.length,
      enqueued: this.metrics.enqueued,
      delivered: this.metrics.delivered,
      failed: this.metrics.failed,
      deadLettered: this.metrics.deadLettered,
    };
  }

  private startFlushLoop(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        this.logger.warn(
          { component: 'NotificationQueue', error: String(err) },
          'Flush loop error'
        );
      });
    }, this.flushIntervalMs);
    // Allow process to exit without waiting for the timer
    if (typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Attempt delivery of all queued messages using the configured deliver function.
   * Messages that exhaust retries are moved to the dead-letter queue.
   */
  async flush(): Promise<{ delivered: number; remaining: number; deadLettered: number }> {
    if (this.destroyed || this.flushing || !this.deliver) {
      return {
        delivered: 0,
        remaining: this.queue.length,
        deadLettered: 0,
      };
    }

    this.flushing = true;
    let delivered = 0;
    let deadLettered = 0;
    const remaining: QueuedMessage[] = [];

    try {
      const batch = [...this.queue];
      this.queue = [];

      for (const item of batch) {
        const now = Date.now();
        // Respect backoff based on attempts
        if (item.lastAttemptAt) {
          const backoff = this.retryDelayMs * Math.pow(2, Math.min(item.attempts, 6));
          if (now - item.lastAttemptAt < backoff) {
            remaining.push(item);
            continue;
          }
        }

        try {
          const ok = await this.deliver(item.message, item.priority);
          if (ok) {
            delivered++;
            this.metrics.delivered++;
          } else {
            item.attempts += 1;
            item.lastAttemptAt = now;
            this.metrics.failed++;
            if (item.attempts >= this.retryAttempts) {
              this.deadLetter.push(item);
              this.metrics.deadLettered++;
              deadLettered++;
              this.onDeadLetter?.(item);
              this.logger.error(
                { component: 'NotificationQueue', messageId: item.id, attempts: item.attempts },
                'Message moved to dead-letter queue'
              );
            } else {
              remaining.push(item);
            }
          }
        } catch (err) {
          item.attempts += 1;
          item.lastAttemptAt = now;
          this.metrics.failed++;
          if (item.attempts >= this.retryAttempts) {
            this.deadLetter.push(item);
            this.metrics.deadLettered++;
            deadLettered++;
            this.onDeadLetter?.(item);
          } else {
            remaining.push(item);
          }
          this.logger.warn(
            { component: 'NotificationQueue', error: String(err), messageId: item.id },
            'Delivery attempt failed'
          );
        }
      }

      this.queue = remaining.concat(this.queue);
    } finally {
      this.flushing = false;
    }

    return {
      delivered,
      remaining: this.queue.length,
      deadLettered,
    };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.queue = [];
    // Keep dead-letter for inspection until process exit
  }
}
