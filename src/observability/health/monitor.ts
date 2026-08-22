import { EventEmitter } from 'events';
import { HealthCheckResult, HealthStatus, ComponentHealth } from '../../types/health';
import { HealthCheck } from './checks';
import { getLogger } from '../logger';

export interface HealthMonitorOptions {
  intervalMs: number;
  degradationThreshold: number;
  failureThreshold: number;
}

export class HealthMonitor extends EventEmitter {
  private checks: Map<string, HealthCheck> = new Map();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly options: HealthMonitorOptions;
  private lastResult: HealthCheckResult | null = null;
  private consecutiveDegraded = 0;
  private consecutiveFailures = 0;

  constructor(options: HealthMonitorOptions) {
    super();
    this.options = options;
  }

  registerCheck(check: HealthCheck): void {
    this.checks.set(check.name, check);
    getLogger().info({ component: 'HealthMonitor' }, `Registered health check: ${check.name}`);
  }

  unregisterCheck(name: string): void {
    this.checks.delete(name);
    getLogger().info({ component: 'HealthMonitor' }, `Unregistered health check: ${name}`);
  }

  async runChecks(): Promise<HealthCheckResult> {
    const components: ComponentHealth[] = [];
    let worstStatus: HealthStatus = 'OK';

    for (const [name, check] of this.checks) {
      try {
        const result = await check.execute();
        components.push(result);
        if (result.status === 'FAILING') {
          worstStatus = 'FAILING';
        } else if (result.status === 'DEGRADED' && worstStatus !== 'FAILING') {
          worstStatus = 'DEGRADED';
        } else if (result.status === 'UNKNOWN' && worstStatus === 'OK') {
          worstStatus = 'UNKNOWN';
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        components.push({
          component: name,
          status: 'FAILING',
          message: `Check threw exception: ${message}`,
          lastCheckedAt: new Date().toISOString(),
        });
        worstStatus = 'FAILING';
      }
    }

    const result: HealthCheckResult = {
      overallStatus: worstStatus,
      components,
      checkedAt: new Date().toISOString(),
    };

    this.lastResult = result;
    this.emit('check', result);

    // Track consecutive degraded/failing states
    if (worstStatus === 'DEGRADED') {
      this.consecutiveDegraded++;
      this.consecutiveFailures = 0;
      if (this.consecutiveDegraded >= this.options.degradationThreshold) {
        this.emit('degraded', result);
      }
    } else if (worstStatus === 'FAILING') {
      this.consecutiveDegraded = 0;
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.options.failureThreshold) {
        this.emit('failing', result);
      }
    } else {
      this.consecutiveDegraded = 0;
      this.consecutiveFailures = 0;
    }

    return result;
  }

  start(): void {
    if (this.intervalId) return;
    getLogger().info({ component: 'HealthMonitor' }, 'Starting health monitor');
    this.intervalId = setInterval(() => {
      this.runChecks().catch((err) => {
        getLogger().error({ component: 'HealthMonitor' }, `Health check runner error: ${err}`);
      });
    }, this.options.intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      getLogger().info({ component: 'HealthMonitor' }, 'Stopped health monitor');
    }
  }

  getLastResult(): HealthCheckResult | null {
    return this.lastResult;
  }

  isHealthy(): boolean {
    return this.lastResult?.overallStatus === 'OK';
  }
}
