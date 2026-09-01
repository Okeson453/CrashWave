import type { BetPlacementAdapter, PlaceBetRequest } from '../types.js';

/**
 * Mock bet placement adapter for testing and dry-run mode.
 */
export class MockBetPlacementAdapter implements BetPlacementAdapter {
  private shouldConfirm = true;
  private confirmDelayMs = 0;
  private shouldFailSubmission = false;
  private cashOutResult: { success: boolean; multiplier?: number; pnl?: number } = {
    success: true,
    multiplier: 1.3,
    pnl: 210,
  };

  setBehavior(options: {
    shouldConfirm?: boolean;
    confirmDelayMs?: number;
    shouldFailSubmission?: boolean;
    cashOutSuccess?: boolean;
    cashOutMultiplier?: number;
    cashOutPnl?: number;
  }): void {
    if (options.shouldConfirm !== undefined) this.shouldConfirm = options.shouldConfirm;
    if (options.confirmDelayMs !== undefined) this.confirmDelayMs = options.confirmDelayMs;
    if (options.shouldFailSubmission !== undefined) this.shouldFailSubmission = options.shouldFailSubmission;
    if (options.cashOutSuccess !== undefined) this.cashOutResult.success = options.cashOutSuccess;
    if (options.cashOutMultiplier !== undefined) this.cashOutResult.multiplier = options.cashOutMultiplier;
    if (options.cashOutPnl !== undefined) this.cashOutResult.pnl = options.cashOutPnl;
  }

  async submitBet(_request: PlaceBetRequest): Promise<boolean> {
    if (this.shouldFailSubmission) return false;
    return true;
  }

  async waitForConfirmation(_betId: string, _timeoutMs: number): Promise<boolean> {
    if (this.confirmDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.confirmDelayMs));
    }
    return this.shouldConfirm;
  }

  async requestCashOut(_betId: string, _roundId: string): Promise<boolean> {
    return this.cashOutResult.success;
  }

  async waitForCashOutConfirmation(_betId: string, _timeoutMs: number): Promise<{
    success: boolean;
    multiplier: number | null;
    pnl: number | null;
    error?: string;
  }> {
    if (this.confirmDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.confirmDelayMs));
    }
    return {
      success: this.cashOutResult.success,
      multiplier: this.cashOutResult.multiplier ?? null,
      pnl: this.cashOutResult.pnl ?? null,
      error: this.cashOutResult.success ? undefined : 'Cash-out failed',
    };
  }
}
