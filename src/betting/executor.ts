import { getLogger } from '../observability/logger';
import { withTimeout } from '../utils/async';
import { Mutex } from '../utils/async';
import {
  BetExecutorConfig,
  PlaceBetRequest,
  BetExecutionResult,
  BetPlacementAdapter,
} from './types';
import { IdempotencyKeyStore } from './idempotency';

/**
 * BetExecutor handles the physical placement of bets and manages the
 * lifecycle from submission through confirmation.
 *
 * Key responsibilities:
 * - Mutex-protected bet placement (only one bet at a time)
 * - Idempotency verification before placement
 * - Timeout handling for confirmation
 * - Retry logic with exponential backoff
 * - State tracking (PENDING → PLACED → CONFIRMED / FAILED)
 */
export class BetExecutor {
  private readonly logger = getLogger();
  private readonly config: BetExecutorConfig;
  private readonly adapter: BetPlacementAdapter;
  private readonly idempotency: IdempotencyKeyStore;
  private readonly mutex = new Mutex();

  constructor(
    adapter: BetPlacementAdapter,
    idempotency: IdempotencyKeyStore,
    config?: Partial<BetExecutorConfig>
  ) {
    this.adapter = adapter;
    this.idempotency = idempotency;
    this.config = {
      stake: 700,
      target: 1.30,
      placementTimeoutMs: 10000,
      cashOutTimeoutMs: 8000,
      maxPlacementRetries: 2,
      placementRetryDelayMs: 1000,
      useNativeAutoCashOut: false,
      ...config,
    };
  }

  /**
   * Place a bet with full safety controls:
   * 1. Acquire mutex (prevents concurrent bets)
   * 2. Check idempotency (prevents duplicate bets for same round)
   * 3. Submit bet via adapter
   * 4. Wait for confirmation with timeout
   * 5. Update idempotency record
   *
   * The mutex is released in a finally block to prevent deadlocks.
   */
  async placeBet(request: PlaceBetRequest): Promise<BetExecutionResult> {
    await this.mutex.acquire();
    const attemptedAt = new Date().toISOString();

    try {
      this.logger.info(
        {
          component: 'BetExecutor',
          betId: request.betId,
          roundId: request.roundId,
          sessionId: request.sessionId,
          stake: request.stake,
          dryRun: request.dryRun,
        },
        'Starting bet placement'
      );

      // 1. Idempotency check
      const reserved = await this.idempotency.reserve(
        request.sessionId,
        request.roundId,
        request.betId
      );
      if (!reserved) {
        const error = 'Duplicate bet attempt blocked by idempotency check';
        this.logger.warn(
          { component: 'BetExecutor', betId: request.betId, roundId: request.roundId },
          error
        );
        return {
          placed: false,
          state: 'FAILED',
          error,
          attemptedAt,
          confirmedAt: null,
          retryCount: 0,
        };
      }

      // 2. Dry-run: simulate success without physical placement
      if (request.dryRun) {
        this.logger.info(
          { component: 'BetExecutor', betId: request.betId },
          'Dry-run mode — simulating bet placement'
        );
        await this.idempotency.complete(request.sessionId, request.roundId, {
          success: true,
          betId: request.betId,
        });
        return {
          placed: true,
          state: 'CONFIRMED',
          attemptedAt,
          confirmedAt: attemptedAt,
          retryCount: 0,
        };
      }

      // 3. Submit bet with retries
      let lastError: string | undefined;
      let retryCount = 0;

      for (let attempt = 0; attempt <= this.config.maxPlacementRetries; attempt++) {
        if (attempt > 0) {
          retryCount = attempt;
          this.logger.info(
            {
              component: 'BetExecutor',
              betId: request.betId,
              attempt: attempt + 1,
              maxRetries: this.config.maxPlacementRetries + 1,
            },
            `Retrying bet placement (attempt ${attempt + 1})`
          );
          await this.delay(this.config.placementRetryDelayMs * attempt);
        }

        try {
          const submitted = await this.adapter.submitBet(request);
          if (!submitted) {
            lastError = 'Bet submission rejected by adapter';
            continue;
          }

          // 4. Wait for confirmation
          const confirmed = await withTimeout(
            this.adapter.waitForConfirmation(request.betId, this.config.placementTimeoutMs),
            this.config.placementTimeoutMs,
            'Bet confirmation timed out'
          );

          if (confirmed) {
            await this.idempotency.complete(request.sessionId, request.roundId, {
              success: true,
              betId: request.betId,
            });

            this.logger.info(
              {
                component: 'BetExecutor',
                betId: request.betId,
                roundId: request.roundId,
                retries: retryCount,
              },
              'Bet placement confirmed'
            );

            return {
              placed: true,
              state: 'CONFIRMED',
              attemptedAt,
              confirmedAt: new Date().toISOString(),
              retryCount,
            };
          } else {
            lastError = 'Bet was submitted but confirmation was not received';
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          this.logger.warn(
            {
              component: 'BetExecutor',
              betId: request.betId,
              attempt: attempt + 1,
              error: lastError,
            },
            'Bet placement attempt failed'
          );
        }
      }

      // All retries exhausted
      const finalError = lastError ?? 'Bet placement failed after all retries';
      await this.idempotency.fail(request.sessionId, request.roundId, finalError);

      this.logger.error(
        {
          component: 'BetExecutor',
          betId: request.betId,
          roundId: request.roundId,
          retries: retryCount,
          error: finalError,
        },
        'Bet placement failed permanently'
      );

      return {
        placed: false,
        state: 'FAILED',
        error: finalError,
        attemptedAt,
        confirmedAt: null,
        retryCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { component: 'BetExecutor', betId: request.betId, error: message },
        'Unexpected error during bet placement'
      );

      await this.idempotency.fail(request.sessionId, request.roundId, message).catch(() => {
        // Best-effort: don't let idempotency failure mask the real error
      });

      return {
        placed: false,
        state: 'FAILED',
        error: message,
        attemptedAt,
        confirmedAt: null,
        retryCount: 0,
      };
    } finally {
      this.mutex.release();
    }
  }

  /**
   * Check if the executor is currently placing a bet (mutex held).
   */
  isBusy(): boolean {
    return this.mutex.isLocked();
  }

  /**
   * Get the current mutex state.
   */
  getMutexState(): { locked: boolean } {
    return { locked: this.mutex.isLocked() };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

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
