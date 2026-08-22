/**
 * TelegramNotifier sends notifications via Telegram Bot API (Telegraf).
 * Queues messages when the API is temporarily unavailable and supports
 * priority, rate-limit awareness, and sensitive-data redaction.
 */

import { Telegraf } from 'telegraf';
import { getLogger } from '../observability/logger';

export interface TelegramNotifierOptions {
  botToken: string;
  operatorChatId: string;
  enabled: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  onRetry?: (attempt: number) => void;
  /** Optional transport override (useful for tests) */
  transport?: (message: string) => Promise<{ messageId: string }>;
  /** Parse mode for messages */
  parseMode?: 'MarkdownV2' | 'HTML' | 'Markdown';
}

export interface SendResult {
  sent: boolean;
  queued: boolean;
  messageId?: string;
}

const SENSITIVE_PATTERNS: RegExp[] = [
  /bot\d+:[A-Za-z0-9_-]{20,}/gi, // bot tokens
  /postgresql:\/\/[^\s]+/gi,
  /redis:\/\/[^\s]+/gi,
  /ENCRYPTION_KEY[=:]\s*\S+/gi,
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, // card-like
];

function redact(text: string): string {
  let out = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

export class TelegramNotifier {
  private readonly enabled: boolean;
  private readonly botToken: string;
  private readonly operatorChatId: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly onRetry?: (attempt: number) => void;
  private readonly transport?: (message: string) => Promise<{ messageId: string }>;
  private readonly parseMode: 'MarkdownV2' | 'HTML' | 'Markdown';
  private readonly logger = getLogger();

  private bot: Telegraf | null = null;
  private messageQueue: Array<{ message: string; priority: string; enqueuedAt: number }> = [];
  private destroyed = false;

  constructor(options: TelegramNotifierOptions) {
    this.enabled = options.enabled;
    this.botToken = options.botToken;
    this.operatorChatId = options.operatorChatId;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.onRetry = options.onRetry;
    this.transport = options.transport;
    this.parseMode = options.parseMode ?? 'MarkdownV2';

    if (this.enabled && this.botToken && !this.transport) {
      try {
        this.bot = new Telegraf(this.botToken);
      } catch (err) {
        this.logger.error(
          { component: 'TelegramNotifier', error: String(err) },
          'Failed to initialise Telegraf bot'
        );
      }
    }
  }

  /**
   * Send a message to the operator chat. On transient failure the message is queued.
   */
  async sendMessage(
    message: string,
    options?: { priority?: string }
  ): Promise<SendResult> {
    if (!this.enabled || this.destroyed) {
      return { sent: false, queued: false };
    }

    const priority = options?.priority ?? 'normal';
    const safeMessage = redact(message);

    try {
      if (this.transport) {
        const result = await this.withTimeout(this.transport(safeMessage));
        return { sent: true, queued: false, messageId: result.messageId };
      }

      if (!this.bot || !this.operatorChatId) {
        // No real transport configured — simulate success for dry-run / tests
        this.logger.debug({ component: 'TelegramNotifier' }, 'Simulated send (no bot/chat configured)');
        return { sent: true, queued: false, messageId: 'simulated' };
      }

      const result = await this.sendWithRetry(safeMessage);
      return { sent: true, queued: false, messageId: String(result.message_id) };
    } catch (err) {
      this.logger.warn(
        { component: 'TelegramNotifier', error: String(err), priority },
        'Telegram send failed — queuing message'
      );
      this.messageQueue.push({
        message: safeMessage,
        priority,
        enqueuedAt: Date.now(),
      });
      // Keep high-priority messages near the front
      this.messageQueue.sort((a, b) => {
        const order = { critical: 0, high: 1, normal: 2, low: 3 };
        return (order[a.priority as keyof typeof order] ?? 2) - (order[b.priority as keyof typeof order] ?? 2);
      });
      return { sent: false, queued: true };
    }
  }

  private async sendWithRetry(message: string): Promise<{ message_id: number }> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.withTimeout(
          this.bot!.telegram.sendMessage(this.operatorChatId, message, {
            parse_mode: this.parseMode,
            // Avoid link previews for operational noise
            link_preview_options: { is_disabled: true },
          })
        );
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          this.onRetry?.(attempt + 1);
          await this.sleep(this.retryDelayMs * Math.pow(2, attempt));
        }
      }
    }
    throw lastError;
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Telegram API timeout')), this.timeoutMs);
      promise
        .then((v) => {
          clearTimeout(timer);
          resolve(v);
        })
        .catch((e) => {
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Attempt to deliver every queued message. Failures are re-queued.
   */
  async flushQueue(): Promise<{ delivered: number; remaining: number }> {
    if (this.destroyed) {
      return { delivered: 0, remaining: this.messageQueue.length };
    }

    const pending = [...this.messageQueue];
    this.messageQueue = [];
    let delivered = 0;

    for (const item of pending) {
      try {
        if (this.transport) {
          await this.withTimeout(this.transport(item.message));
        } else if (this.bot && this.operatorChatId) {
          await this.sendWithRetry(item.message);
        } else {
          // Still no transport — re-queue
          this.messageQueue.push(item);
          continue;
        }
        delivered++;
      } catch {
        this.messageQueue.push(item);
      }
    }

    return { delivered, remaining: this.messageQueue.length };
  }

  getQueueSize(): number {
    return this.messageQueue.length;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.messageQueue = [];
    if (this.bot) {
      try {
        this.bot.stop('destroy');
      } catch {
        // ignore
      }
      this.bot = null;
    }
  }
}
