import { Page } from 'playwright';
import { BetRepository } from '../../persistence/repositories/bet-repo';
import { getLogger } from '../logger';
import { EventBus, getEventBus } from '../../core/event-bus/bus';

/**
 * Health status for a single component.
 */
export interface ComponentHealth {
  component: string;
  status: 'healthy' | 'degraded' | 'critical' | 'unknown';
  message: string;
  latencyMs?: number;
  lastCheckedAt: string;
}

/**
 * Overall system health report.
 */
export interface SystemHealthReport {
  overall: 'healthy' | 'degraded' | 'critical';
  components: ComponentHealth[];
  timestamp: string;
  unknownBets: number;
  activeBets: number;
  consecutiveDegradedChecks: number;
}

/**
 * Configuration for live health checks.
 */
export interface LiveHealthCheckConfig {
  /** Interval between health check runs (ms) */
  checkIntervalMs: number;
  /** Number of consecutive degraded checks before escalating to critical */
  degradationThreshold: number;
  /** DOM selector for the game canvas (indicates game is loaded) */
  gameCanvasSelector: string;
  /** DOM selector for the balance display */
  balanceDisplaySelector: string;
  /** Timeout for DOM health checks */
  domCheckTimeoutMs: number;
  /** Max acceptable balance fetch latency */
  maxBalanceLatencyMs: number;
  /** Max acceptable bet placement latency (from history) */
  maxPlacementLatencyMs: number;
}

const DEFAULT_HEALTH_CONFIG: LiveHealthCheckConfig = {
  checkIntervalMs: 30000,
  degradationThreshold: 3,
  gameCanvasSelector: 'canvas[data-testid="crash-game-canvas"], .crash-game canvas',
  balanceDisplaySelector: '[data-testid="balance-display"], .balance, .user-balance',
  domCheckTimeoutMs: 5000,
  maxBalanceLatencyMs: 2000,
  maxPlacementLatencyMs: 5000,
};

/**
 * LiveHealthChecks performs continuous health monitoring of all
 * components critical to live betting:
 *
 *   1. Browser / DOM connectivity (game page responsive).
 *   2. Balance display accessibility.
 *   3. Bet repository connectivity.
 *   4. Active and unknown bet counts.
 *   5. Recent latency trends.
 *
 * If the system is degraded for too many consecutive checks, a
 * CriticalError event is emitted and betting should be paused.
 */
export class LiveHealthChecks {
  private readonly logger = getLogger();
  private readonly config: LiveHealthCheckConfig;
  private consecutiveDegraded = 0;
  private lastReport: SystemHealthReport | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly page: Page,
    private readonly betRepo: BetRepository,
    private readonly eventBus: EventBus = getEventBus(),
    config?: Partial<LiveHealthCheckConfig>
  ) {
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
  }

  /**
   * Starts periodic health checks.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info({ component: 'LiveHealthChecks' }, 'Health checks started');

    // Run immediately, then on interval
    this.runCheck().catch((err) => {
      this.logger.error({ component: 'LiveHealthChecks', error: String(err) }, 'Initial health check failed');
    });

    this.intervalId = setInterval(() => {
      this.runCheck().catch((err) => {
        this.logger.error({ component: 'LiveHealthChecks', error: String(err) }, 'Periodic health check failed');
      });
    }, this.config.checkIntervalMs);
  }

  /**
   * Stops periodic health checks.
   */
  stop(): void {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.logger.info({ component: 'LiveHealthChecks' }, 'Health checks stopped');
  }

  /**
   * Returns whether health checks are running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Returns the most recent health report.
   */
  getLastReport(): SystemHealthReport | null {
    return this.lastReport;
  }

  /**
   * Runs a single health check cycle across all components.
   */
  async runCheck(): Promise<SystemHealthReport> {
    const timestamp = new Date().toISOString();
    const components: ComponentHealth[] = [];

    // 1. Browser DOM health
    const domHealth = await this.checkDomHealth();
    components.push(domHealth);

    // 2. Balance display health
    const balanceHealth = await this.checkBalanceDisplayHealth();
    components.push(balanceHealth);

    // 3. Database connectivity
    const dbHealth = await this.checkDatabaseHealth();
    components.push(dbHealth);

    // 4. Bet state health
    const betHealth = await this.checkBetStateHealth();
    components.push(betHealth);

    // Determine overall status
    const hasCritical = components.some((c) => c.status === 'critical');
    const hasDegraded = components.some((c) => c.status === 'degraded');

    let overall: SystemHealthReport['overall'] = 'healthy';
    if (hasCritical) {
      overall = 'critical';
    } else if (hasDegraded) {
      overall = 'degraded';
    }

    // Track consecutive degraded checks
    if (overall === 'degraded' || overall === 'critical') {
      this.consecutiveDegraded++;
    } else {
      this.consecutiveDegraded = 0;
    }

    // Escalation: too many degraded checks → critical
    if (this.consecutiveDegraded >= this.config.degradationThreshold) {
      overall = 'critical';
      this.logger.error(
        {
          component: 'LiveHealthChecks',
          consecutiveDegraded: this.consecutiveDegraded,
          threshold: this.config.degradationThreshold,
        },
        'Health degraded for too many consecutive checks — escalating to CRITICAL'
      );

      await this.eventBus.emitTyped('CriticalError', {
        message: `System health degraded for ${this.consecutiveDegraded} consecutive checks`,
        code: 'HEALTH_DEGRADED_ESCALATION',
        component: 'LiveHealthChecks',
      }, `health-${Date.now()}`, 'LiveHealthChecks');
    }

    const report: SystemHealthReport = {
      overall,
      components,
      timestamp,
      unknownBets: betHealth.details?.unknownBets ?? 0,
      activeBets: betHealth.details?.activeBets ?? 0,
      consecutiveDegradedChecks: this.consecutiveDegraded,
    };

    this.lastReport = report;

    if (overall !== 'healthy') {
      this.logger.warn(
        { component: 'LiveHealthChecks', overall, components },
        `System health: ${overall}`
      );
    } else {
      this.logger.debug({ component: 'LiveHealthChecks' }, 'System health: healthy');
    }

    return report;
  }

  private async checkDomHealth(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const canvas = this.page.locator(this.config.gameCanvasSelector).first();
      await canvas.waitFor({ state: 'visible', timeout: this.config.domCheckTimeoutMs });
      const latencyMs = Date.now() - start;

      return {
        component: 'browser-dom',
        status: 'healthy',
        message: 'Game canvas is visible and responsive',
        latencyMs,
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      return {
        component: 'browser-dom',
        status: 'critical',
        message: `Game canvas not found or not visible: ${error instanceof Error ? error.message : String(error)}`,
        latencyMs,
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }

  private async checkBalanceDisplayHealth(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const display = this.page.locator(this.config.balanceDisplaySelector).first();
      const visible = await display.isVisible().catch(() => false);
      const latencyMs = Date.now() - start;

      if (!visible) {
        return {
          component: 'balance-display',
          status: 'degraded',
          message: 'Balance display element is not visible',
          latencyMs,
          lastCheckedAt: new Date().toISOString(),
        };
      }

      if (latencyMs > this.config.maxBalanceLatencyMs) {
        return {
          component: 'balance-display',
          status: 'degraded',
          message: `Balance display slow: ${latencyMs}ms > ${this.config.maxBalanceLatencyMs}ms`,
          latencyMs,
          lastCheckedAt: new Date().toISOString(),
        };
      }

      return {
        component: 'balance-display',
        status: 'healthy',
        message: 'Balance display responsive',
        latencyMs,
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      return {
        component: 'balance-display',
        status: 'critical',
        message: `Balance display check failed: ${error instanceof Error ? error.message : String(error)}`,
        latencyMs,
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }

  private async checkDatabaseHealth(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      // Lightweight query to verify connectivity
      const count = await this.betRepo.count();
      const latencyMs = Date.now() - start;

      return {
        component: 'database',
        status: 'healthy',
        message: `Database connected (${count} total bets)`,
        latencyMs,
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      return {
        component: 'database',
        status: 'critical',
        message: `Database check failed: ${error instanceof Error ? error.message : String(error)}`,
        latencyMs,
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }

  private async checkBetStateHealth(): Promise<ComponentHealth & { details?: { unknownBets: number; activeBets: number } }> {
    try {
      const unknownBets = await this.betRepo.countByState('UNKNOWN');
      const activeBets = await this.betRepo.countByState('ACTIVE') +
        await this.betRepo.countByState('PLACED') +
        await this.betRepo.countByState('CONFIRMED') +
        await this.betRepo.countByState('CASH_OUT_REQUESTED');

      if (unknownBets > 0) {
        return {
          component: 'bet-state',
          status: 'degraded',
          message: `${unknownBets} bet(s) in UNKNOWN state require reconciliation`,
          lastCheckedAt: new Date().toISOString(),
          details: { unknownBets, activeBets },
        };
      }

      if (activeBets > 1) {
        return {
          component: 'bet-state',
          status: 'degraded',
          message: `${activeBets} active bets detected — possible overlap`,
          lastCheckedAt: new Date().toISOString(),
          details: { unknownBets, activeBets },
        };
      }

      return {
        component: 'bet-state',
        status: 'healthy',
        message: `Bet states healthy (${activeBets} active, ${unknownBets} unknown)`,
        lastCheckedAt: new Date().toISOString(),
        details: { unknownBets, activeBets },
      };
    } catch (error) {
      return {
        component: 'bet-state',
        status: 'critical',
        message: `Bet state check failed: ${error instanceof Error ? error.message : String(error)}`,
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }
}
