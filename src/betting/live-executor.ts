import { Page } from 'playwright';

import { BetRepository } from '../persistence/repositories/bet-repo';
import { EventBus, getEventBus } from '../core/event-bus/bus';
import { getLogger } from '../observability/logger';
import { withTimeout, Mutex } from '../utils/async';
import { TimeoutError, LiveExecutionError } from '../utils/errors';
import { BetState } from '../types/betting';
import { SelectorCanary } from '../game/selector-canary';
import { HumanInput } from '../browser/human-input';
import { Humanizer } from '../browser/humanize';
import { DOM_SELECTORS } from '../game/constants';
import { VelocityController } from '../risk/velocity-controller';

import { ExecutionSafeguards } from './execution-safeguards';
import { ConfirmationObserver } from './confirmation';
import { PlaceBetRequest } from './types';
import { TelemetryNoise } from './telemetry-noise';
import { IdempotencyKeyStore } from './idempotency';
import type { InMemoryCapitalGuard } from '../capital/in-memory-limits';
import type { ClientOrderIdRegistry } from '../core/reconciliation-service';
import { biomechanicalClick } from '../browser/biomechanical-input';
import type { AuthoritativeSettlementEngine } from '../settlement/authoritative-settlement-engine';

/**
 * Result of a live bet placement attempt.
 */
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

/**
 * Configuration for live bet execution.
 */
export interface LiveExecutorConfig {
  /** DOM selector for the bet amount input field */
  betAmountSelector: string;
  /** DOM selector for the place-bet button */
  placeBetButtonSelector: string;
  /** DOM selector that appears when a bet is active */
  activeBetIndicatorSelector: string;
  /** Timeout for the full placement + confirmation cycle */
  placementTimeoutMs: number;
  /** Max retries on transient failures */
  maxPlacementRetries: number;
  /** Delay between retries */
  placementRetryDelayMs: number;
  /** Delay after clicking bet button before starting confirmation observation */
  postClickObservationDelayMs: number;
}

const DEFAULT_CONFIG: LiveExecutorConfig = {
  betAmountSelector: DOM_SELECTORS.betAmountInput,
  placeBetButtonSelector: DOM_SELECTORS.placeBetButton,
  activeBetIndicatorSelector: DOM_SELECTORS.activeBetIndicator,
  placementTimeoutMs: 8000,
  maxPlacementRetries: 2,
  placementRetryDelayMs: 500,
  postClickObservationDelayMs: 300,
};

/**
 * LiveBetExecutor handles real-money bet placement on the BC.Game Crash
 * interface. It interacts with the DOM directly, observes confirmation
 * through both DOM mutations and WebSocket traffic, and updates the
 * persistent bet record atomically.
 *
 * Every placement follows this flow:
 *   1. Pre-flight safeguards (balance, health, round state).
 *   2. Idempotency check (round-level deduplication).
 *   3. DOM interaction: clear input → enter stake → click Bet.
 *   4. Confirmation observation (DOM + WS) with timeout.
 *   5. Post-flight validation and event emission.
 *   6. Atomic DB update to PLACED or FAILED.
 *
 * If confirmation times out, the bet state becomes UNKNOWN and the
 * reconciliation pipeline is triggered.
 */
export class LiveBetExecutor {
  private readonly logger = getLogger();
  private readonly mutex = new Mutex();
  private readonly config: LiveExecutorConfig;
  private stopped = false;

  constructor(
    private readonly page: Page,
    private readonly betRepo: BetRepository,
    private readonly confirmationObserver: ConfirmationObserver,
    private readonly safeguards: ExecutionSafeguards,
    private readonly eventBus: EventBus = getEventBus(),
    config?: Partial<LiveExecutorConfig>,
    private readonly selectorCanary?: SelectorCanary,
    private readonly humanInput?: HumanInput,
    private readonly velocityController?: VelocityController,
    private readonly humanizer?: Humanizer,
    private readonly telemetryNoise?: TelemetryNoise,
    private readonly idempotency?: IdempotencyKeyStore,
    private readonly capitalGuard?: InMemoryCapitalGuard,
    private readonly orderRegistry?: ClientOrderIdRegistry,
    private readonly useBiomechanical?: boolean,
    private readonly settlementEngine?: AuthoritativeSettlementEngine
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Returns true if a placement is currently in progress.
   */
  isBusy(): boolean {
    return this.mutex.isLocked();
  }

  /**
   * Permanently disables this executor. Any in-flight placement will
   * finish, but subsequent calls will reject immediately.
   */
  stop(): void {
    this.stopped = true;
    this.logger.warn({ component: 'LiveBetExecutor' }, 'Executor stopped');
  }

  /**
   * Attempts to place a live bet. This is the single entry-point for
   * real-money entry into a crash round.
   */
  async placeLiveBet(request: PlaceBetRequest): Promise<LiveBetResult> {
    if (this.stopped) {
      return this.buildResult(request, 'FAILED', 'Executor is stopped');
    }

    const startTime = Date.now();
    const correlationId = request.betId;

    // 0. Selector canary pre-action gate (P0.7 / remaining risk)
    if (this.selectorCanary) {
      const gate = await this.selectorCanary.assertCriticalPresent();
      if (!gate.ok) {
        const reason = `Critical selectors missing: ${gate.missing.join(', ')}`;
        this.logger.error(
          { component: 'LiveBetExecutor', correlationId: request.betId, missing: gate.missing },
          'Aborting placement — selector canary failed'
        );
        return this.buildResult(request, 'FAILED', reason);
      }
    }

    // 1. Pre-flight safeguards
    const preFlight = await this.safeguards.checkPreFlight(request);
    if (!preFlight.approved) {
      this.logger.warn(
        { component: 'LiveBetExecutor', correlationId, reason: preFlight.reason },
        'Pre-flight check failed'
      );
      return this.buildResult(request, 'FAILED', preFlight.reason ?? 'Pre-flight rejected', 0, Date.now() - startTime);
    }

    // 1a. Synchronous in-memory capital limits (fail closed, zero async)
    if (this.capitalGuard) {
      const cap = this.capitalGuard.canPlaceBet(request.stake);
      if (!cap.allowed) {
        this.logger.warn(
          { component: 'LiveBetExecutor', correlationId, reason: cap.reason },
          'Capital guard rejected placement'
        );
        return this.buildResult(request, 'FAILED', cap.reason ?? 'capital_guard_rejected', 0, Date.now() - startTime);
      }
    }

    // 1a2. Pre-flight client_order_id tagging (before any network frame)
    let clientOrderId: string | undefined;
    if (this.orderRegistry) {
      clientOrderId = this.orderRegistry.generate(request.stake, request.target);
      (request as any).clientOrderId = clientOrderId;
      this.logger.debug(
        { component: 'LiveBetExecutor', correlationId, clientOrderId },
        'client_order_id reserved'
      );

      if (this.settlementEngine && clientOrderId) {
        try {
          await this.settlementEngine.createOrderIntent({
            clientOrderId,
            betId: request.betId,
            roundId: request.roundId,
            wagerAmount: request.stake,
            targetMultiplier: request.target,
          });
          await this.settlementEngine.markDispatched(clientOrderId);
        } catch (err) {
          this.logger.error(
            { component: 'LiveBetExecutor', correlationId, error: String(err) },
            'Settlement order intent failed'
          );
          this.orderRegistry?.release(clientOrderId);
          return this.buildResult(request, 'FAILED', 'settlement_intent_failed', 0, Date.now() - startTime);
        }
      }
    }

    // 1b. Round-level idempotency (Redis NX) — fail closed
    if (this.idempotency) {
      const reserved = await this.idempotency.reserve(
        request.sessionId,
        request.roundId,
        request.betId
      );
      if (!reserved) {
        this.logger.warn(
          { component: 'LiveBetExecutor', correlationId, roundId: request.roundId },
          'Idempotency collision — blocking duplicate placement'
        );
        return this.buildResult(
          request,
          'FAILED',
          'idempotency_collision',
          0,
          Date.now() - startTime
        );
      }
    }

    // 2. Acquire mutex (only one live placement at a time)
    await this.mutex.acquire();
    let retryCount = 0;

    try {
      this.logger.info(
        {
          component: 'LiveBetExecutor',
          correlationId,
          roundId: request.roundId,
          stake: request.stake,
        },
        'Starting live bet placement'
      );

      // 3. Create the bet record in PENDING state
      const dailyKey = this.safeguards.getDailyKey();
      const balanceBefore = preFlight.currentBalance ?? null;

      try {
        await this.betRepo.create({
          sessionId: request.sessionId,
          roundId: request.roundId,
          dailyKey,
          stake: request.stake,
          cashOutTarget: request.target,
          state: 'PENDING',
          balanceBefore,
        });
        const coid = (request as any).clientOrderId as string | undefined;
        if (coid) {
          await this.eventBus.emitTyped('ClientOrderIdBound', {
            betId: request.betId,
            clientOrderId: coid,
            roundId: request.roundId,
          } as any, request.betId, 'LiveBetExecutor').catch?.(() => undefined);
          // Also store on event bus generic publish for cash-out wiring
          try {
            (this.eventBus as any).publish?.({
              type: 'ClientOrderIdBound',
              payload: { betId: request.betId, clientOrderId: coid, roundId: request.roundId },
            });
          } catch { /* optional */ }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error({ component: 'LiveBetExecutor', correlationId, error: message }, 'Failed to create bet record');
        return this.buildResult(request, 'FAILED', `DB error: ${message}`, 0, Date.now() - startTime);
      }

      // 4. Placement attempt with limited pre-click retries only.
      // CRITICAL: after a physical click (or UNKNOWN), NEVER retry — that would double-bet.
      while (retryCount <= this.config.maxPlacementRetries) {
        try {
          const result = await this.attemptPlacement(request, startTime);
          return result;
        } catch (error) {
          // Post-click uncertainty: attemptPlacement already marked UNKNOWN — do not retry.
          if (error instanceof TimeoutError) {
            this.logger.error(
              { component: 'LiveBetExecutor', correlationId, error: error.message },
              'Confirmation timeout after click — UNKNOWN, no retry'
            );
            return this.buildResult(
              request,
              'UNKNOWN',
              error.message,
              retryCount,
              Date.now() - startTime
            );
          }
          if (error instanceof LiveExecutionError) {
            // LiveExecutionError before click may be safe to retry; after RESERVED/click is not.
            // attemptPlacement throws LiveExecutionError only for pre-click DOM failures
            // (or marks UNKNOWN and throws TimeoutError post-click).
            if (retryCount < this.config.maxPlacementRetries) {
              retryCount++;
              this.logger.warn(
                {
                  component: 'LiveBetExecutor',
                  correlationId,
                  retry: retryCount,
                  error: error.message,
                },
                'Pre-click placement failed, retrying'
              );
              await this.delay(this.config.placementRetryDelayMs);
              continue;
            }
            return this.buildResult(
              request,
              'FAILED',
              error.message,
              retryCount,
              Date.now() - startTime
            );
          }
          throw error;
        }
      }

      return this.buildResult(
        request,
        'FAILED',
        'All pre-click placement retries exhausted',
        retryCount,
        Date.now() - startTime
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: 'LiveBetExecutor', correlationId, error: message }, 'Live bet placement failed');

      // Mark as UNKNOWN if we cannot determine the outcome
      await this.markUnknown(request.betId, message, request.sessionId, request.roundId);

      await this.eventBus.emitTyped('BetFailed', {
        roundId: request.roundId,
        sessionId: request.sessionId,
        reason: message,
      }, correlationId, 'LiveBetExecutor');

      return this.buildResult(request, 'UNKNOWN', message, retryCount, Date.now() - startTime);
    } finally {
      this.mutex.release();
    }
  }

  /**
   * Single attempt at DOM placement + confirmation.
   */
  private async attemptPlacement(
    request: PlaceBetRequest,
    startTime: number
  ): Promise<LiveBetResult> {
    // Velocity / rate limit gate
    if (this.velocityController) {
      const decision = await this.velocityController.waitUntilAllowed('bet_placement', 120_000);
      if (!decision.allowed) {
        throw new LiveExecutionError(`Velocity gate blocked placement: ${decision.reason}
    // Hard live gate: refuse silent bot-like fill/click
    if (!this.humanInput?.isEnabled() && !this.humanizer) {
      // Only enforce when safeguards expect live — check via placement path
      this.logger.error({ component: 'LiveBetExecutor' }, 'Humanization missing on placement path');
      throw new LiveExecutionError('LIVE_HUMANIZATION_REQUIRED');
    }
`);
      }
    }
    // Optional telemetry noise — skip entry
    if (this.telemetryNoise?.shouldSkipEntry()) {
      this.logger.info({ component: 'LiveBetExecutor', betId: request.betId }, 'Telemetry noise: skipping entry');
      return {
        placed: false,
        betId: request.betId,
        roundId: request.roundId,
        state: 'FAILED' as BetState,
        confirmedAt: null,
        error: 'telemetry_noise_skip',
        retryCount: 0,
        latencyMs: Date.now() - startTime,
      };
    }

    const correlationId = request.betId;

    // 4a. Update state to RESERVED (we are about to click)
    await this.betRepo.updateState(request.betId, 'RESERVED');

    // 4b. DOM interaction: set stake and click Bet
    await this.interactWithDom(request);

    // 4c. Start confirmation observation — AFTER physical click.
    // From this point, failures must be UNKNOWN (never retriable click).
    await this.delay(this.config.postClickObservationDelayMs);

    let confirmed = false;
    try {
      confirmed = await withTimeout(
        this.confirmationObserver.waitForBetPlaced(request.roundId, request.sessionId),
        this.config.placementTimeoutMs,
        `Bet placement confirmation timed out for round ${request.roundId}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.markUnknown(request.betId, message, request.sessionId, request.roundId);
      // Terminal: return UNKNOWN result (do not throw LiveExecutionError — outer loop must not re-click)
      return this.buildResult(
        request,
        'UNKNOWN',
        message,
        0,
        Date.now() - startTime
      );
    }

    if (!confirmed) {
      await this.markUnknown(request.betId, 'Placement confirmation not observed', request.sessionId, request.roundId);
      return this.buildResult(
        request,
        'UNKNOWN',
        'Placement confirmation not observed',
        0,
        Date.now() - startTime
      );
    }

    // 4d. Bet is confirmed — update DB and emit events
    const confirmedAt = new Date().toISOString();
    const latencyMs = Date.now() - startTime;

    await this.betRepo.update(request.betId, {
      state: 'PLACED',
      placedAt: confirmedAt,
      confirmedAt,
    });

    if (this.idempotency) {
      await this.idempotency.complete(request.sessionId, request.roundId, {
        success: true,
        betId: request.betId,
      });
    }

    await this.eventBus.emitTyped('BetPlaced', {
      betId: request.betId,
      roundId: request.roundId,
      sessionId: request.sessionId,
      stake: request.stake,
      target: request.target,
    }, correlationId, 'LiveBetExecutor');

    // 5. Post-flight validation
    const postFlight = await this.safeguards.checkPostFlight(request, 'PLACED');
    if (!postFlight.valid) {
      this.logger.warn(
        { component: 'LiveBetExecutor', correlationId, warning: postFlight.warning },
        'Post-flight validation warning'
      );
    }

    return {
      placed: true,
      betId: request.betId,
      roundId: request.roundId,
      state: 'PLACED',
      confirmedAt,
      error: null,
      retryCount: 0,
      latencyMs,
    };
  }

  /**
   * Interacts with the DOM to place a bet.
   *
   * Steps:
   *   1. Wait for the bet amount input to be visible.
   *   2. Clear it and type the stake.
   *   3. Wait for the place-bet button to be enabled.
   *   4. Click it.
   */
  private async interactWithDom(request: PlaceBetRequest): Promise<void> {
    try {
      // 1. Amount input
      const amountInput = this.page.locator(this.config.betAmountSelector).first();
      await amountInput.waitFor({ state: 'visible', timeout: 3000 });
      if (this.humanInput?.isEnabled()) {
        await this.humanInput.typeStake(amountInput, request.stake);
      } else {
        await amountInput.fill(String(request.stake));
        await this.delay(50);
      }

      // 2. Bet button
      const betButton = this.page.locator(this.config.placeBetButtonSelector).first();
      await betButton.waitFor({ state: 'visible', timeout: 3000 });

      const isDisabled = await betButton.isDisabled().catch(() => true);
      if (isDisabled) {
        throw new LiveExecutionError('Place-bet button is disabled');
      }

      if (this.humanizer) {
        if (this.useBiomechanical) {
          const box = await this.page.locator(this.config.placeBetButtonSelector).first().boundingBox();
          if (box) {
            await biomechanicalClick(this.page, box.x + box.width / 2, box.y + box.height / 2);
          } else {
            await this.humanizer.click(this.page, this.config.placeBetButtonSelector);
          }
        } else {
          await this.humanizer.click(this.page, this.config.placeBetButtonSelector);
        }
      } else if (this.humanInput?.isEnabled()) {
        await this.humanInput.click(betButton);
      } else {
        await betButton.click();
      }
      this.velocityController?.record('bet_placement');

      this.logger.debug(
        { component: 'LiveBetExecutor', betId: request.betId },
        'DOM interaction completed (input filled + button clicked)'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LiveExecutionError(`DOM interaction failed: ${message}`);
    }
  }

  /**
   * Marks a bet as UNKNOWN and emits the appropriate event.
   */
  private async markUnknown(
    betId: string,
    reason: string,
    sessionId?: string,
    roundId?: string
  ): Promise<void> {
    try {
      await this.betRepo.update(betId, {
        state: 'UNKNOWN',
        failureReason: reason,
      });
      if (this.idempotency && sessionId && roundId) {
        // Keep key present so retries cannot re-click; mark failed for observability
        await this.idempotency.fail(sessionId, roundId, reason).catch(() => undefined);
      }
      this.logger.error(
        { component: 'LiveBetExecutor', betId, reason },
        'Bet marked UNKNOWN — reconciliation required'
      );
    } catch (dbError) {
      this.logger.fatal(
        { component: 'LiveBetExecutor', betId, error: String(dbError) },
        'Failed to mark bet UNKNOWN in database'
      );
    }
  }

  private buildResult(
    request: PlaceBetRequest,
    state: BetState,
    error: string | null,
    retryCount = 0,
    latencyMs = 0
  ): LiveBetResult {
    return {
      placed: state === 'PLACED',
      betId: request.betId,
      roundId: request.roundId,
      state,
      confirmedAt: state === 'PLACED' ? new Date().toISOString() : null,
      error,
      retryCount,
      latencyMs,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
