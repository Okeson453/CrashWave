/**
 * LiveBetExecutor — Playwright placement path for real (non dry-run) bets.
 * Adapted from Crash reference; uses CrashWave mode gate + optional adapter.
 * Never places when dry-run / non-live / ALLOW_REAL_EXECUTION is off.
 */
import type { Page } from 'playwright';
import { randomUUID } from 'crypto';
import { getLogger } from '../observability/logger';
import { Mutex } from '../utils/async';
import { DOM_SELECTORS } from '../game/constants';
import { BetRepository } from '../persistence/repositories/bet-repo';
import { realExecutionBlockReason } from './execution-mode-gate';
import { IdempotencyKeyStore, InMemoryIdempotencyStore } from './idempotency';
import type { PlaceBetRequest } from './types';
import type { BetState } from '../types/betting';

export interface LiveBetResult {
  placed: boolean;
  betId: string;
  roundId: string;
  state: BetState;
  confirmedAt: string | null;
  error: string | null;
  retryCount: number;
  latencyMs: number;
}

export interface LiveExecutorConfig {
  betAmountSelector: string;
  placeBetButtonSelector: string;
  activeBetIndicatorSelector: string;
  placementTimeoutMs: number;
  maxPlacementRetries: number;
  placementRetryDelayMs: number;
}

const DEFAULT_CONFIG: LiveExecutorConfig = {
  betAmountSelector: DOM_SELECTORS.betAmountInput,
  placeBetButtonSelector: DOM_SELECTORS.placeBetButton,
  activeBetIndicatorSelector: DOM_SELECTORS.activeBetIndicator,
  placementTimeoutMs: 10_000,
  maxPlacementRetries: 2,
  placementRetryDelayMs: 500,
};

export class LiveBetExecutor {
  private readonly logger = getLogger().child({ component: 'LiveBetExecutor' });
  private readonly mutex = new Mutex();
  private readonly config: LiveExecutorConfig;
  private stopped = false;

  constructor(
    private page: Page | null,
    private readonly betRepo: BetRepository,
    private readonly idempotency: IdempotencyKeyStore = new InMemoryIdempotencyStore(),
    config?: Partial<LiveExecutorConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  bindPage(page: Page | null): void {
    this.page = page;
  }

  isBusy(): boolean {
    return this.mutex.isLocked();
  }

  stop(): void {
    this.stopped = true;
  }

  async placeLiveBet(request: PlaceBetRequest): Promise<LiveBetResult> {
    const start = Date.now();
    if (this.stopped) {
      return this.fail(request, 'Executor is stopped', 0, start);
    }
    const blocked = realExecutionBlockReason(request.dryRun, 'LiveBetExecutor');
    if (blocked) {
      this.logger.warn({ reason: blocked, roundId: request.roundId }, 'Real execution blocked');
      return this.fail(request, blocked, 0, start);
    }
    if (!this.page || this.page.isClosed()) {
      return this.fail(request, 'BROWSER_PAGE_UNAVAILABLE', 0, start);
    }

    await this.mutex.acquire();
    let retryCount = 0;
    try {
      const reserved = await this.idempotency.reserve(
        request.sessionId,
        request.roundId,
        request.betId
      );
      if (!reserved) {
        return this.fail(request, 'Duplicate bet blocked by idempotency', 0, start);
      }

      const dailyKey = new Date().toISOString().slice(0, 10);
      try {
        await this.betRepo.create({
          sessionId: request.sessionId,
          roundId: request.roundId,
          dailyKey,
          stake: request.stake,
          cashOutTarget: request.target,
          state: 'PENDING',
        });
      } catch (err) {
        this.logger.warn({ error: String(err) }, 'Bet repo create failed (continuing placement)');
      }

      let lastError = 'placement_failed';
      for (retryCount = 0; retryCount <= this.config.maxPlacementRetries; retryCount++) {
        try {
          const amount = this.page.locator(this.config.betAmountSelector).first();
          await amount.waitFor({ state: 'visible', timeout: this.config.placementTimeoutMs });
          await amount.fill('');
          await amount.fill(String(request.stake));

          const btn = this.page.locator(this.config.placeBetButtonSelector).first();
          await btn.waitFor({ state: 'visible', timeout: this.config.placementTimeoutMs });
          await btn.click({ timeout: this.config.placementTimeoutMs });

          const confirmed = await this.page
            .locator(this.config.activeBetIndicatorSelector)
            .first()
            .waitFor({ state: 'visible', timeout: this.config.placementTimeoutMs })
            .then(() => true)
            .catch(() => false);

          if (confirmed) {
            const confirmedAt = new Date().toISOString();
            try {
              await this.idempotency.complete(request.sessionId, request.roundId, {
                success: true,
              } as never);
            } catch {
              /* optional */
            }
            this.logger.info(
              { betId: request.betId, roundId: request.roundId, stake: request.stake },
              'Live bet placed and confirmed'
            );
            return {
              placed: true,
              betId: request.betId,
              roundId: request.roundId,
              state: 'CONFIRMED',
              confirmedAt,
              error: null,
              retryCount,
              latencyMs: Date.now() - start,
            };
          }
          lastError = 'PLACEMENT_NOT_CONFIRMED';
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          this.logger.warn({ error: lastError, retryCount }, 'Live placement attempt failed');
        }
        if (retryCount < this.config.maxPlacementRetries) {
          await new Promise((r) => setTimeout(r, this.config.placementRetryDelayMs));
        }
      }
      return this.fail(request, lastError, retryCount, start);
    } finally {
      this.mutex.release();
    }
  }

  /** Convenience builder for live requests */
  static buildRequest(opts: {
    roundId: string;
    sessionId: string;
    stake: number;
    target: number;
  }): PlaceBetRequest {
    const betId = randomUUID();
    return {
      betId,
      roundId: opts.roundId,
      sessionId: opts.sessionId,
      stake: opts.stake,
      target: opts.target,
      idempotencyKey: IdempotencyKeyStore.generateKey(opts.sessionId, opts.roundId),
      dryRun: false,
    };
  }

  private fail(
    request: PlaceBetRequest,
    error: string,
    retryCount: number,
    start: number
  ): LiveBetResult {
    return {
      placed: false,
      betId: request.betId,
      roundId: request.roundId,
      state: 'FAILED',
      confirmedAt: null,
      error,
      retryCount,
      latencyMs: Date.now() - start,
    };
  }
}
