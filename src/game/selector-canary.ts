/**
 * SelectorCanary continuously verifies that critical DOM selectors still resolve.
 * On disappearance of critical selectors it emits health degradation events and
 * can trigger auto-pause of live/dry-run entry (never interpret missing UI as success).
 */

import { Page } from 'playwright';
import { EventEmitter } from 'events';
import { DOM_SELECTORS } from './constants';
import { getLogger } from '../observability/logger';

export type SelectorCriticality = 'critical' | 'important' | 'optional';

export interface CanarySelector {
  name: string;
  selector: string;
  criticality: SelectorCriticality;
}

export interface SelectorCheckResult {
  name: string;
  selector: string;
  criticality: SelectorCriticality;
  present: boolean;
  count: number;
  checkedAt: string;
}

export interface CanaryReport {
  healthy: boolean;
  missingCritical: string[];
  missingImportant: string[];
  results: SelectorCheckResult[];
  checkedAt: string;
}

export interface SelectorCanaryOptions {
  page: Page;
  /** Override selector list; defaults to critical set from DOM_SELECTORS */
  selectors?: CanarySelector[];
  intervalMs?: number;
  /** Consecutive failed critical checks before emitting critical failure */
  failureThreshold?: number;
  onDegraded?: (report: CanaryReport) => void;
  onCritical?: (report: CanaryReport) => void;
}

/** Default critical selectors that must exist for safe observation / live action */
export const DEFAULT_CANARY_SELECTORS: CanarySelector[] = [
  { name: 'gameContainer', selector: DOM_SELECTORS.gameContainer, criticality: 'critical' },
  { name: 'multiplierDisplay', selector: DOM_SELECTORS.multiplierDisplay, criticality: 'critical' },
  { name: 'balanceDisplay', selector: DOM_SELECTORS.balanceDisplay, criticality: 'critical' },
  { name: 'betButton', selector: DOM_SELECTORS.betButton, criticality: 'important' },
  { name: 'placeBetButton', selector: DOM_SELECTORS.placeBetButton, criticality: 'important' },
  { name: 'cashOutButton', selector: DOM_SELECTORS.cashOutButton, criticality: 'important' },
  { name: 'betInput', selector: DOM_SELECTORS.betInput, criticality: 'important' },
  { name: 'betAmountInput', selector: DOM_SELECTORS.betAmountInput, criticality: 'important' },
  { name: 'activeBetIndicator', selector: DOM_SELECTORS.activeBetIndicator, criticality: 'optional' },
  { name: 'roundIdDisplay', selector: DOM_SELECTORS.roundIdDisplay, criticality: 'optional' },
];

export class SelectorCanary extends EventEmitter {
  private readonly page: Page;
  private readonly selectors: CanarySelector[];
  private readonly intervalMs: number;
  private readonly failureThreshold: number;
  private readonly onDegraded?: (report: CanaryReport) => void;
  private readonly onCritical?: (report: CanaryReport) => void;
  private readonly logger = getLogger();

  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveCriticalFailures = 0;
  private lastReport: CanaryReport | null = null;
  private running = false;

  constructor(options: SelectorCanaryOptions) {
    super();
    this.page = options.page;
    this.selectors = options.selectors ?? DEFAULT_CANARY_SELECTORS;
    this.intervalMs = options.intervalMs ?? 15_000;
    this.failureThreshold = options.failureThreshold ?? 2;
    this.onDegraded = options.onDegraded;
    this.onCritical = options.onCritical;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info(
      { component: 'SelectorCanary', intervalMs: this.intervalMs, count: this.selectors.length },
      'Selector canary started'
    );
    // Run immediately then on interval
    void this.runCheck();
    this.timer = setInterval(() => {
      void this.runCheck();
    }, this.intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info({ component: 'SelectorCanary' }, 'Selector canary stopped');
  }

  getLastReport(): CanaryReport | null {
    return this.lastReport;
  }

  isHealthy(): boolean {
    return this.lastReport?.healthy ?? true;
  }

  /**
   * One-shot verification of all configured selectors.
   * Safe to call before any live action (pre-action gate).
   */
  async runCheck(): Promise<CanaryReport> {
    const results: SelectorCheckResult[] = [];
    const checkedAt = new Date().toISOString();

    for (const item of this.selectors) {
      let present = false;
      let count = 0;
      try {
        count = await this.page.locator(item.selector).count();
        present = count > 0;
      } catch (err) {
        this.logger.warn(
          { component: 'SelectorCanary', name: item.name, error: String(err) },
          'Selector check threw'
        );
        present = false;
        count = 0;
      }
      results.push({
        name: item.name,
        selector: item.selector,
        criticality: item.criticality,
        present,
        count,
        checkedAt,
      });
    }

    const missingCritical = results
      .filter((r) => r.criticality === 'critical' && !r.present)
      .map((r) => r.name);
    const missingImportant = results
      .filter((r) => r.criticality === 'important' && !r.present)
      .map((r) => r.name);

    const healthy = missingCritical.length === 0;
    const report: CanaryReport = {
      healthy,
      missingCritical,
      missingImportant,
      results,
      checkedAt,
    };
    this.lastReport = report;

    if (!healthy) {
      this.consecutiveCriticalFailures++;
      this.logger.warn(
        {
          component: 'SelectorCanary',
          missingCritical,
          consecutive: this.consecutiveCriticalFailures,
        },
        'Critical selectors missing'
      );
      this.emit('degraded', report);
      this.onDegraded?.(report);

      if (this.consecutiveCriticalFailures >= this.failureThreshold) {
        this.emit('critical', report);
        this.onCritical?.(report);
        this.logger.error(
          {
            component: 'SelectorCanary',
            missingCritical,
            threshold: this.failureThreshold,
          },
          'Selector canary CRITICAL — auto-pause recommended'
        );
      }
    } else {
      if (this.consecutiveCriticalFailures > 0) {
        this.logger.info({ component: 'SelectorCanary' }, 'Critical selectors recovered');
      }
      this.consecutiveCriticalFailures = 0;
      if (missingImportant.length > 0) {
        this.emit('degraded', report);
        this.onDegraded?.(report);
      } else {
        this.emit('healthy', report);
      }
    }

    return report;
  }

  /**
   * Pre-action gate: returns false if any critical selector is missing.
   * Call before live place-bet or cash-out.
   */
  async assertCriticalPresent(): Promise<{ ok: boolean; missing: string[] }> {
    const report = await this.runCheck();
    return {
      ok: report.healthy,
      missing: report.missingCritical,
    };
  }
}
