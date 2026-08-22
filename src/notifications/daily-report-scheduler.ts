/**
 * DailyReportScheduler — at UTC day boundary:
 *   generate report → queue → Telegram
 */

import { getLogger } from '../observability/logger.js';
import { NotificationQueue } from './queue.js';

export interface DailyReportSchedulerOptions {
  queue: NotificationQueue | null;
  /** Provider returns a ready-to-send text message */
  reportProvider?: () => Promise<string> | string;
  checkIntervalMs?: number;
}

export class DailyReportScheduler {
  private readonly logger = getLogger();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReportDay: string | null = null;
  private readonly queue: NotificationQueue | null;
  private readonly reportProvider: () => Promise<string> | string;
  private readonly checkIntervalMs: number;

  constructor(options: DailyReportSchedulerOptions) {
    this.queue = options.queue;
    this.checkIntervalMs = options.checkIntervalMs ?? 60_000;
    this.reportProvider =
      options.reportProvider ??
      (() => {
        const day = new Date().toISOString().slice(0, 10);
        return `📊 *Daily Report* ${day}\n\n_Analytics state not yet bound — use /daily for live snapshot._`;
      });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.checkIntervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
    this.logger.info({ component: 'DailyReportScheduler' }, 'Daily report scheduler started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<string> {
    const text = await Promise.resolve(this.reportProvider());
    if (this.queue) {
      this.queue.enqueue(text, 'high');
    }
    this.lastReportDay = new Date().toISOString().slice(0, 10);
    this.logger.info(
      { component: 'DailyReportScheduler', day: this.lastReportDay },
      'Daily report delivered'
    );
    return text;
  }

  private async tick(): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const hour = new Date().getUTCHours();
    const minute = new Date().getUTCMinutes();
    if (hour === 0 && minute < 5 && this.lastReportDay !== day) {
      try {
        await this.runOnce();
      } catch (err) {
        this.logger.error(
          { component: 'DailyReportScheduler', error: String(err) },
          'Daily report failed'
        );
      }
    }
  }
}
