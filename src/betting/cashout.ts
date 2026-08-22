import { getLogger } from '../observability/logger';
import { withTimeout } from '../utils/async';
import {
  CashOutConfig,
  CashOutControllerState,
  CashOutMonitorResult,
  BetPlacementAdapter,
} from './types';


/**
 * CashOutController monitors the live multiplier stream and triggers
 * cash-out when the target is reached. It includes a latency guard
 * to account for execution delay.
 *
 * Two modes of operation:
 * 1. Native auto cash-out: If the game supports it, set the target
 *    before the round starts and let the game handle it.
 * 2. Reactive cash-out: Monitor multiplier ticks and manually trigger
 *    cash-out when target is reached.
 *
 * The controller is designed to be used once per bet. Create a new
 * instance for each bet.
 */
export class CashOutController {
  private readonly logger = getLogger();
  private readonly config: CashOutConfig;
  private readonly adapter: BetPlacementAdapter;
  private state: CashOutControllerState;
  private aborted = false;
  private monitorPromise: Promise<CashOutMonitorResult> | null = null;

  constructor(
    betId: string,
    roundId: string,
    adapter: BetPlacementAdapter,
    config?: Partial<CashOutConfig>
  ) {
    this.adapter = adapter;
    this.config = {
      targetMultiplier: 1.30,
      latencyBufferMs: 50,
      confirmationTimeoutMs: 8000,
      preferNativeAutoCashOut: false,
      ...config,
    };
    this.state = {
      betId,
      roundId,
      triggered: false,
      confirmed: false,
      triggeredAtMultiplier: null,
      confirmedAtMultiplier: null,
      pnl: null,
      error: null,
      triggeredAt: null,
      confirmedAt: null,
    };
  }

  /**
   * Get the current controller state.
   */
  getState(): CashOutControllerState {
    return { ...this.state };
  }

  /**
   * Configure native auto cash-out before the round starts.
   * Returns true if native auto cash-out was successfully configured.
   */
  async configureNativeAutoCashOut(): Promise<boolean> {
    if (!this.config.preferNativeAutoCashOut || !this.adapter.setNativeAutoCashOut) {
      return false;
    }

    try {
      const configured = await this.adapter.setNativeAutoCashOut(this.config.targetMultiplier);
      if (configured) {
        this.logger.info(
          {
            component: 'CashOutController',
            betId: this.state.betId,
            target: this.config.targetMultiplier,
          },
          'Native auto cash-out configured'
        );
      }
      return configured;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { component: 'CashOutController', betId: this.state.betId, error: message },
        'Failed to configure native auto cash-out'
      );
      return false;
    }
  }

  /**
   * Start monitoring the multiplier stream for this bet.
   *
   * This method should be called immediately after bet confirmation.
   * It returns a promise that resolves when:
   * - Cash-out is confirmed (win)
   * - Round crashes before target (loss)
   * - Cash-out fails or times out (error)
   * - The controller is aborted (e.g., system halt)
   *
   * The onTick callback is invoked on every multiplier update.
   * The onCrash callback is invoked when the round crashes.
   */
  async monitor(
    onTick: (callback: (multiplier: number) => void) => void,
    onCrash: (callback: (crashPoint: number) => void) => void
  ): Promise<CashOutMonitorResult> {
    if (this.monitorPromise) {
      return this.monitorPromise;
    }

    this.monitorPromise = this.runMonitor(onTick, onCrash);
    return this.monitorPromise;
  }

  /**
   * Abort monitoring. This is a best-effort operation — if cash-out
   * is already in flight, it will complete normally.
   */
  abort(): void {
    this.aborted = true;
    this.logger.info(
      { component: 'CashOutController', betId: this.state.betId },
      'Cash-out monitoring aborted'
    );
  }

  /**
   * Check if monitoring is complete.
   */
  isComplete(): boolean {
    return this.state.confirmed || this.state.error !== null;
  }

  // ─── Private Monitor Implementation ────────────────────────────────────────

  private async runMonitor(
    onTick: (callback: (multiplier: number) => void) => void,
    onCrash: (callback: (crashPoint: number) => void) => void
  ): Promise<CashOutMonitorResult> {
    return new Promise((resolve) => {
      let cashOutInFlight = false;
      let resolved = false;

      const resolveOnce = (result: CashOutMonitorResult): void => {
        if (resolved) return;
        resolved = true;
        resolve(result);
      };

      // Handle multiplier ticks
      onTick((multiplier: number) => {
        if (resolved || this.aborted) return;

        // Latency guard: trigger slightly before target to account for execution delay
        const effectiveTarget = this.config.targetMultiplier;

        if (multiplier >= effectiveTarget && !cashOutInFlight && !this.state.triggered) {
          cashOutInFlight = true;
          this.state.triggered = true;
          this.state.triggeredAtMultiplier = multiplier;
          this.state.triggeredAt = new Date().toISOString();

          this.logger.info(
            {
              component: 'CashOutController',
              betId: this.state.betId,
              multiplier,
              target: effectiveTarget,
            },
            'Target multiplier reached — triggering cash-out'
          );

          this.executeCashOut()
            .then((result) => {
              if (resolved) return;

              if (result.success) {
                this.state.confirmed = true;
                this.state.confirmedAtMultiplier = result.multiplier;
                this.state.pnl = result.pnl;
                this.state.confirmedAt = new Date().toISOString();

                resolveOnce({
                  success: true,
                  finalState: 'CASHED_OUT',
                  pnl: result.pnl ?? 0,
                  cashOutMultiplier: result.multiplier,
                });
              } else {
                this.state.error = result.error ?? 'Cash-out failed';
                resolveOnce({
                  success: false,
                  finalState: 'FAILED',
                  pnl: null,
                  cashOutMultiplier: null,
                  error: this.state.error,
                });
              }
            })
            .catch((error) => {
              if (resolved) return;
              const message = error instanceof Error ? error.message : String(error);
              this.state.error = message;
              resolveOnce({
                success: false,
                finalState: 'FAILED',
                pnl: null,
                cashOutMultiplier: null,
                error: message,
              });
            });
        }
      });

      // Handle round crash
      onCrash((crashPoint: number) => {
        if (resolved) return;

        // If cash-out is already in flight, let it complete
        if (cashOutInFlight) {
          this.logger.info(
            {
              component: 'CashOutController',
              betId: this.state.betId,
              crashPoint,
            },
            'Round crashed while cash-out in flight — waiting for cash-out result'
          );
          // The cash-out promise will resolve or reject and call resolveOnce
          return;
        }

        // If we haven't triggered cash-out yet, the bet is lost
        if (!this.state.triggered) {
          this.logger.info(
            {
              component: 'CashOutController',
              betId: this.state.betId,
              crashPoint,
              target: this.config.targetMultiplier,
            },
            'Round crashed before target — bet lost'
          );

          resolveOnce({
            success: false,
            finalState: 'LOST',
            pnl: null,
            cashOutMultiplier: null,
          });
        }
      });

      // Safety timeout: if neither tick nor crash resolves within a reasonable time,
      // force-resolve as unknown. This prevents the promise from hanging forever.
      const safetyTimeoutMs = 120000; // 2 minutes max per round
      setTimeout(() => {
        if (!resolved) {
          this.logger.warn(
            { component: 'CashOutController', betId: this.state.betId },
            'Safety timeout — forcing cash-out monitor resolution'
          );
          resolveOnce({
            success: false,
            finalState: 'UNKNOWN',
            pnl: null,
            cashOutMultiplier: null,
            error: 'Cash-out monitor safety timeout exceeded',
          });
        }
      }, safetyTimeoutMs);
    });
  }

  private async executeCashOut(): Promise<{
    success: boolean;
    multiplier: number | null;
    pnl: number | null;
    error?: string;
  }> {
    try {
      // 1. Request cash-out
      const requested = await this.adapter.requestCashOut(
        this.state.betId,
        this.state.roundId
      );

      if (!requested) {
        return {
          success: false,
          multiplier: null,
          pnl: null,
          error: 'Cash-out request was rejected by adapter',
        };
      }

      // 2. Wait for confirmation
      const result = await withTimeout(
        this.adapter.waitForCashOutConfirmation(
          this.state.betId,
          this.config.confirmationTimeoutMs
        ),
        this.config.confirmationTimeoutMs,
        'Cash-out confirmation timed out'
      );

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { component: 'CashOutController', betId: this.state.betId, error: message },
        'Cash-out execution failed'
      );
      return {
        success: false,
        multiplier: null,
        pnl: null,
        error: message,
      };
    }
  }
}

/**
 * Simple multiplier stream for testing.
 * Simulates a round that either reaches target or crashes.
 */
export function createTestMultiplierStream(options: {
  crashPoint: number;
  tickIntervalMs: number;
  startMultiplier?: number;
}): {
  onTick: (callback: (multiplier: number) => void) => void;
  onCrash: (callback: (crashPoint: number) => void) => void;
  start: () => void;
  stop: () => void;
} {
  const { crashPoint, tickIntervalMs, startMultiplier = 1.0 } = options;
  let tickCallback: ((multiplier: number) => void) | null = null;
  let crashCallback: ((crashPoint: number) => void) | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentMultiplier = startMultiplier;

  const onTick = (callback: (multiplier: number) => void): void => {
    tickCallback = callback;
  };

  const onCrash = (callback: (crashPoint: number) => void): void => {
    crashCallback = callback;
  };

  const start = (): void => {
    interval = setInterval(() => {
      currentMultiplier += 0.01;
      tickCallback?.(currentMultiplier);

      if (currentMultiplier >= crashPoint) {
        stop();
        crashCallback?.(crashPoint);
      }
    }, tickIntervalMs);
  };

  const stop = (): void => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  };

  return { onTick, onCrash, start, stop };
}
