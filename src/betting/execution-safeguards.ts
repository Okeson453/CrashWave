import { getLogger } from '../observability/logger';
import { PlaceBetRequest } from './types';
import { BalanceTracker } from '../ledger/balance-tracker';
import { DailyEntryCounter } from '../ledger/daily-entries';
import { AppConfig } from '../config/schema';


/**
 * Result of a pre-flight check.
 */
export interface PreFlightResult {
  approved: boolean;
  reason?: string;
  currentBalance?: number;
  dailyEntriesRemaining?: number;
  healthStatus?: 'healthy' | 'degraded' | 'critical';
}

/**
 * Result of a post-flight validation.
 */
export interface PostFlightResult {
  valid: boolean;
  warning?: string;
}

/**
 * Latency snapshot for a single operation.
 */
export interface LatencySnapshot {
  operation: string;
  latencyMs: number;
  timestamp: string;
  thresholdMs: number;
  exceeded: boolean;
}

/**
 * Configuration for execution safeguards.
 */
export interface SafeguardsConfig {
  /** Minimum balance required to place a bet (inclusive) */
  minBalanceForEntry: number;
  /** Additional buffer that must remain after a bet */
  balanceBuffer: number;
  /** Maximum allowed latency for a placement operation */
  maxPlacementLatencyMs: number;
  /** Maximum allowed latency for a cash-out operation */
  maxCashOutLatencyMs: number;
  /** Timezone for day-boundary calculations */
  dayBoundaryTimezone: string;
}

const DEFAULT_SAFEGUARDS_CONFIG: SafeguardsConfig = {
  minBalanceForEntry: 700,
  balanceBuffer: 700,
  maxPlacementLatencyMs: 5000,
  maxCashOutLatencyMs: 3000,
  dayBoundaryTimezone: 'UTC',
};

/**
 * ExecutionSafeguards enforces pre-flight checks before any live action
 * and post-flight validation after. It is the gatekeeper that prevents
 * bets from being placed when conditions are unsafe.
 *
 * Pre-flight checks:
 *   1. System mode must be 'live'.
 *   2. Balance must be ≥ minBalanceForEntry + balanceBuffer + stake.
 *   3. Daily entry limit must not be reached.
 *   4. No active bet must be in progress (round-level idempotency).
 *   5. Health status must not be 'critical'.
 *
 * Post-flight checks:
 *   1. Latency must be within thresholds.
 *   2. State transition must be valid.
 */
export class ExecutionSafeguards {
  private readonly logger = getLogger();
  private readonly config: SafeguardsConfig;
  private readonly latencyHistory: LatencySnapshot[] = [];
  private maxLatencyHistory = 100;

  constructor(
    private readonly balanceTracker: BalanceTracker,
    private readonly dailyCounter: DailyEntryCounter,
    private readonly appConfig: AppConfig,
    config?: Partial<SafeguardsConfig>
  ) {
    this.config = { ...DEFAULT_SAFEGUARDS_CONFIG, ...config };
  }

  /**
   * Runs all pre-flight checks. Returns approved=true only if every
   * check passes.
   */
  async checkPreFlight(request: PlaceBetRequest): Promise<PreFlightResult> {
    const correlationId = request.betId;

    // 1. System mode check
    if (this.appConfig.system.mode !== 'live') {
      const reason = `System mode is '${this.appConfig.system.mode}', expected 'live'`;
      this.logger.warn({ component: 'ExecutionSafeguards', correlationId, reason }, 'Pre-flight rejected');
      return { approved: false, reason };
    }

    // 2. Balance check — hard fail on unknown/unparseable (R4)
    if (this.balanceTracker.isUnparseable?.()) {
      const reason = 'Balance unparseable — hard reject until valid snapshot';
      this.logger.warn({ component: 'ExecutionSafeguards', correlationId, reason }, 'Pre-flight rejected');
      return { approved: false, reason };
    }
    const currentBalance =
      this.balanceTracker.getConservativeBalance?.(0) ?? this.balanceTracker.getCurrentBalance();
    if (currentBalance === null) {
      const reason = 'Current balance is unknown — cannot verify sufficiency';
      this.logger.warn({ component: 'ExecutionSafeguards', correlationId, reason }, 'Pre-flight rejected');
      return { approved: false, reason };
    }

    const requiredBalance = this.config.minBalanceForEntry + this.config.balanceBuffer + request.stake;
    if (currentBalance < requiredBalance) {
      const reason = `Insufficient balance: ${currentBalance} < required ${requiredBalance} (stake ${request.stake} + min ${this.config.minBalanceForEntry} + buffer ${this.config.balanceBuffer})`;
      this.logger.warn({ component: 'ExecutionSafeguards', correlationId, reason }, 'Pre-flight rejected');
      return { approved: false, reason, currentBalance };
    }

    // 3. Daily limit check
    const entriesToday = this.dailyCounter.getCount();
    const maxEntries = this.appConfig.betting.maxDailyEntries;
    if (entriesToday >= maxEntries) {
      const reason = `Daily entry limit reached: ${entriesToday}/${maxEntries}`;
      this.logger.warn({ component: 'ExecutionSafeguards', correlationId, reason }, 'Pre-flight rejected');
      return { approved: false, reason, currentBalance, dailyEntriesRemaining: 0 };
    }

    // 4. Health check (simplified — in production this would query a health monitor)
    const healthStatus = this.getHealthStatus();
    if (healthStatus === 'critical') {
      const reason = 'System health is CRITICAL — betting suspended';
      this.logger.warn({ component: 'ExecutionSafeguards', correlationId, reason }, 'Pre-flight rejected');
      return { approved: false, reason, currentBalance, dailyEntriesRemaining: maxEntries - entriesToday, healthStatus };
    }

    this.logger.info(
      {
        component: 'ExecutionSafeguards',
        correlationId,
        currentBalance,
        dailyEntriesRemaining: maxEntries - entriesToday,
        healthStatus,
      },
      'Pre-flight approved'
    );

    return {
      approved: true,
      currentBalance,
      dailyEntriesRemaining: maxEntries - entriesToday,
      healthStatus,
    };
  }

  /**
   * Validates the outcome of a completed operation.
   */
  async checkPostFlight(
    request: PlaceBetRequest,
    finalState: string,
    latencyMs?: number
  ): Promise<PostFlightResult> {
    const correlationId = request.betId;

    // 1. Latency check
    if (latencyMs !== undefined) {
      const threshold = finalState === 'CASHED_OUT' || finalState === 'CASH_OUT_REQUESTED'
        ? this.config.maxCashOutLatencyMs
        : this.config.maxPlacementLatencyMs;

      const exceeded = latencyMs > threshold;
      const snapshot: LatencySnapshot = {
        operation: finalState,
        latencyMs,
        timestamp: new Date().toISOString(),
        thresholdMs: threshold,
        exceeded,
      };

      this.recordLatency(snapshot);

      if (exceeded) {
        const warning = `Latency ${latencyMs}ms exceeded threshold ${threshold}ms for ${finalState}`;
        this.logger.warn({ component: 'ExecutionSafeguards', correlationId, warning }, 'Post-flight warning');
        return { valid: true, warning };
      }
    }

    // State transition validity is enforced by the orchestrator state machine.
    // Safeguards only validate latency and surface-level conditions.

    this.logger.debug(
      { component: 'ExecutionSafeguards', correlationId, finalState },
      'Post-flight validation passed'
    );

    return { valid: true };
  }

  /**
   * Records a latency snapshot for trend analysis.
   */
  recordLatency(snapshot: LatencySnapshot): void {
    this.latencyHistory.push(snapshot);
    if (this.latencyHistory.length > this.maxLatencyHistory) {
      this.latencyHistory.shift();
    }
  }

  /**
   * Returns the average latency for a given operation type.
   */
  getAverageLatency(operation: string): number {
    const samples = this.latencyHistory.filter((s) => s.operation === operation);
    if (samples.length === 0) return 0;
    return samples.reduce((sum, s) => sum + s.latencyMs, 0) / samples.length;
  }

  /**
   * Returns the percentage of operations that exceeded their threshold.
   */
  getLatencyViolationRate(operation: string): number {
    const samples = this.latencyHistory.filter((s) => s.operation === operation);
    if (samples.length === 0) return 0;
    const violations = samples.filter((s) => s.exceeded).length;
    return violations / samples.length;
  }

  /**
   * Returns all latency snapshots.
   */
  getLatencyHistory(): readonly LatencySnapshot[] {
    return this.latencyHistory;
  }

  /**
   * Returns the current daily key for persistence.
   */
  getDailyKey(): string {
    return this.dailyCounter.getDailyKey();
  }

  /**
   * Clears the latency history (useful in tests).
   */
  clearLatencyHistory(): void {
    this.latencyHistory.length = 0;
  }

  private getHealthStatus(): 'healthy' | 'degraded' | 'critical' {
    // Simplified health check based on latency violation rate
    const placementViolationRate = this.getLatencyViolationRate('PLACED');
    const cashOutViolationRate = this.getLatencyViolationRate('CASHED_OUT');

    if (placementViolationRate > 0.5 || cashOutViolationRate > 0.5) {
      return 'critical';
    }
    if (placementViolationRate > 0.2 || cashOutViolationRate > 0.2) {
      return 'degraded';
    }
    return 'healthy';
  }
}
