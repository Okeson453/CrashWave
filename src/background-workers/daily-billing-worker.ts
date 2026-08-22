/**
 * DailyBillingWorker — expire daily subs, morning/evening reminders.
 */

import { getLogger } from '../observability/logger.js';
import { DailyBillingService } from '../platform/billing/daily-billing-service.js';

export class DailyBillingWorker {
  private readonly logger = getLogger();
  private readonly billing: DailyBillingService;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(billing?: DailyBillingService) {
    this.billing = billing ?? new DailyBillingService();
  }

  start(intervalMs = 15 * 60 * 1000): void {
    this.logger.info({ component: 'DailyBillingWorker' }, 'Starting');
    void this.tick();
    this.interval = setInterval(() => void this.tick(), intervalMs);
    if (typeof this.interval === 'object' && 'unref' in this.interval) {
      (this.interval as NodeJS.Timeout).unref();
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private async tick(): Promise<void> {
    try {
      const expired = await this.billing.expireOverdueSubscriptions();
      if (expired.length > 0) {
        this.logger.info(
          { component: 'DailyBillingWorker', count: expired.length },
          'Expired daily subscriptions'
        );
      }
      await this.billing.sendRenewalReminders();
      const hour = new Date().getHours();
      if (hour >= 6 && hour <= 10) {
        await this.billing.sendMorningReminders();
      }
    } catch (err) {
      this.logger.error(
        { component: 'DailyBillingWorker', error: String(err) },
        'Tick failed'
      );
    }
  }
}
