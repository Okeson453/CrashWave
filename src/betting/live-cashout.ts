/**
 * LiveCashOutExecutor — click cash-out on the live Crash UI.
 * Gated by realExecutionBlockReason; never runs in dry-run.
 */
import type { Page } from 'playwright';
import { getLogger } from '../observability/logger';
import { DOM_SELECTORS } from '../game/constants';
import { realExecutionBlockReason } from './execution-mode-gate';
import type { BetState } from '../types/betting';

export interface LiveCashOutResult {
  success: boolean;
  betId: string;
  roundId: string;
  state: BetState;
  cashOutMultiplier: number | null;
  pnl: number | null;
  error: string | null;
  latencyMs: number;
}

export class LiveCashOutExecutor {
  private readonly logger = getLogger().child({ component: 'LiveCashOutExecutor' });
  private stopped = false;
  private targetMultiplier = 1.3;

  constructor(
    private page: Page | null,
    private readonly cashOutSelector = DOM_SELECTORS.cashOutButton,
    private readonly timeoutMs = 8000
  ) {}

  bindPage(page: Page | null): void {
    this.page = page;
  }

  setTarget(target: number): void {
    this.targetMultiplier = target;
  }

  stop(): void {
    this.stopped = true;
  }

  async cashOut(betId: string, roundId: string, dryRun = false): Promise<LiveCashOutResult> {
    const start = Date.now();
    const blocked = realExecutionBlockReason(dryRun, 'LiveCashOutExecutor');
    if (blocked) {
      return {
        success: false,
        betId,
        roundId,
        state: 'FAILED',
        cashOutMultiplier: null,
        pnl: null,
        error: blocked,
        latencyMs: Date.now() - start,
      };
    }
    if (this.stopped || !this.page || this.page.isClosed()) {
      return {
        success: false,
        betId,
        roundId,
        state: 'FAILED',
        cashOutMultiplier: null,
        pnl: null,
        error: 'PAGE_OR_STOPPED',
        latencyMs: Date.now() - start,
      };
    }
    try {
      const btn = this.page.locator(this.cashOutSelector).first();
      await btn.waitFor({ state: 'visible', timeout: this.timeoutMs });
      await btn.click({ timeout: this.timeoutMs });
      this.logger.info({ betId, roundId, target: this.targetMultiplier }, 'Cash-out clicked');
      return {
        success: true,
        betId,
        roundId,
        state: 'CASHED_OUT',
        cashOutMultiplier: this.targetMultiplier,
        pnl: null,
        error: null,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn({ betId, roundId, error }, 'Cash-out failed');
      return {
        success: false,
        betId,
        roundId,
        state: 'FAILED',
        cashOutMultiplier: null,
        pnl: null,
        error,
        latencyMs: Date.now() - start,
      };
    }
  }
}
