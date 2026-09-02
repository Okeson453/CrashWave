/**
 * Playwright-backed bet placement adapter for live / dry-run automation.
 */

import type { Page } from 'playwright';
import type { BetPlacementAdapter, PlaceBetRequest } from '../types.js';
import { DOM_SELECTORS } from '../../game/constants.js';
import { getLogger } from '../../observability/logger.js';

export interface BetDomSelectors {
  betAmount: string;
  placeBet: string;
  activeBet: string;
  cashOut: string;
}

const DEFAULT_SELECTORS: BetDomSelectors = {
  betAmount: DOM_SELECTORS.betAmountInput,
  placeBet: DOM_SELECTORS.placeBetButton,
  activeBet: DOM_SELECTORS.activeBetIndicator,
  cashOut: DOM_SELECTORS.cashOutButton,
};

export class BrowserBetPlacementAdapter implements BetPlacementAdapter {
  private readonly logger = getLogger();
  private readonly selectors: BetDomSelectors;

  constructor(
    private readonly page: Page,
    selectors?: Partial<BetDomSelectors>
  ) {
    this.selectors = { ...DEFAULT_SELECTORS, ...selectors };
  }

  async submitBet(request: PlaceBetRequest): Promise<boolean> {
    try {
      if (request.dryRun) {
        this.logger.debug(
          { component: 'BrowserBetAdapter', stake: request.stake },
          'dryRun submit'
        );
        return true;
      }
      await this.page.fill(this.selectors.betAmount, String(request.stake));
      await this.page.click(this.selectors.placeBet);
      return true;
    } catch (err) {
      this.logger.warn(
        { component: 'BrowserBetAdapter', error: String(err) },
        'submitBet failed'
      );
      return false;
    }
  }

  async waitForConfirmation(_betId: string, timeoutMs: number): Promise<boolean> {
    try {
      await this.page.waitForSelector(this.selectors.activeBet, { timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  async requestCashOut(_betId: string, _roundId: string): Promise<boolean> {
    try {
      await this.page.click(this.selectors.cashOut);
      return true;
    } catch {
      return false;
    }
  }

  async waitForCashOutConfirmation(
    _betId: string,
    timeoutMs: number
  ): Promise<{
    success: boolean;
    multiplier: number | null;
    pnl: number | null;
    error?: string;
  }> {
    try {
      await this.page.waitForSelector(this.selectors.activeBet, {
        state: 'detached',
        timeout: timeoutMs,
      });
      // Read most recent result from history for settlement
      const resultText = await this.page
        .locator(
          '.crash-history .history-item:first-child, .game-history .round-item:first-child, [data-testid="last-crash"]'
        )
        .textContent()
        .catch(() => null);
      let multiplier: number | null = null;
      if (resultText) {
        const match = resultText.match(/(?:x\s*)?(\d+\.?\d*)\s*(?:x|X)?/);
        if (match) {
          const val = parseFloat(match[1]);
          if (val >= 1.0 && val < 100000) multiplier = val;
        }
      }
      return { success: true, multiplier, pnl: null };
    } catch {
      return { success: false, multiplier: null, pnl: null, error: 'cashout timeout' };
    }
  }
}

/** Production guard — never allow mock adapter when NODE_ENV=production */
export function assertNoMockAdapterInProduction(adapter: unknown): void {
  if (process.env.NODE_ENV !== 'production') return;
  const name = (adapter as { constructor?: { name?: string } })?.constructor?.name ?? '';
  if (name === 'MockBetPlacementAdapter') {
    throw new Error('MockBetPlacementAdapter forbidden in production');
  }
}
