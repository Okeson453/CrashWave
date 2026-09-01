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

      // 3. Submit bet. Retries are only allowed before any external side-effect.
      // Once submitBet() has been called, a timeout/uncertain outcome is UNKNOWN
      // and must be reconciled — never blindly retried.
      let lastError: string | undefined;
      let retryCount = 0;
      let externalSideEffectAttempted = false;

      for (let attempt = 0; attempt <= this.config.maxPlacementRetries; attempt++) {
        if (attempt > 0) {
          if (externalSideEffectAttempted) {
            // Safety: never retry after an uncertain external submission
            break;
          }
          retryCount = attempt;
          this.logger.info(
            {
              component: 'BetExecutor',
              betId: request.betId,
              attempt: attempt + 1,
              maxRetries: this.config.maxPlacementRetries + 1,
            },
            `Retrying bet placement (attempt ${attempt + 1}) — pre-submission only`
          );
          await this.delay(this.config.placementRetryDelayMs * attempt);
        }

        try {
          const submitted = await this.adapter.submitBet(request);
          // Physical action may have reached the platform even if we get false/timeout
          externalSideEffectAttempted = true;

          if (!submitted) {
            lastError = 'Bet submission rejected by adapter';
            // Rejection before network may be safe to retry; treat conservatively as UNKNOWN
            // if we cannot prove the request never left the process.
            break;
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
            // Submitted but no confirmation → UNKNOWN / RECONCILING
            lastError = 'Bet was submitted but confirmation was not received (UNKNOWN)';
            break;
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          this.logger.warn(
            {
              component: 'BetExecutor',
              betId: request.betId,
              attempt: attempt + 1,
              error: lastError,
              externalSideEffectAttempted,
            },
            externalSideEffectAttempted
              ? 'Bet placement uncertain after external attempt — will not retry'
              : 'Bet placement attempt failed before confirmed external side-effect'
          );
          if (externalSideEffectAttempted) {
            break;
          }
        }
      }

      // After any external attempt without confirmation → UNKNOWN (reconcile), not FAILED retryable
      const isUnknown = externalSideEffectAttempted;
      const finalError =
        lastError ??
        (isUnknown
          ? 'Bet placement outcome unknown after external submission'
          : 'Bet placement failed after all retries');

      if (isUnknown) {
        await this.idempotency.markUnknown?.(request.sessionId, request.roundId, finalError).catch(async () => {
          // Fallback if markUnknown not implemented
          await this.idempotency.fail(request.sessionId, request.roundId, finalError);
        });
      } else {
        await this.idempotency.fail(request.sessionId, request.roundId, finalError);
      }

      this.logger.error(
        {
          component: 'BetExecutor',
          betId: request.betId,
          roundId: request.roundId,
          retries: retryCount,
          error: finalError,
          state: isUnknown ? 'UNKNOWN' : 'FAILED',
        },
        isUnknown
          ? 'Bet placement UNKNOWN — requires authoritative reconciliation before any new action'
          : 'Bet placement failed permanently'
      );

      return {
        placed: false,
        state: isUnknown ? 'UNKNOWN' : 'FAILED',
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

/** @deprecated import from '@/betting/adapters/mock' */
export { MockBetPlacementAdapter } from './adapters/mock.js';
