import { ComponentHealth, HealthStatus } from '../../types/health';

export interface HealthCheck {
  name: string;
  execute(): Promise<ComponentHealth>;
}

export class DatabaseHealthCheck implements HealthCheck {
  name = 'database';

  constructor(private checkFn: () => Promise<boolean>) {}

  async execute(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const ok = await this.checkFn();
      const latencyMs = Date.now() - start;
      return {
        component: this.name,
        status: ok ? 'OK' : 'FAILING',
        message: ok ? `Connected (${latencyMs}ms)` : 'Connection check returned false',
        lastCheckedAt: new Date().toISOString(),
        metricValue: latencyMs,
      };
    } catch (error) {
      return {
        component: this.name,
        status: 'FAILING',
        message: error instanceof Error ? error.message : String(error),
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }
}

export class RedisHealthCheck implements HealthCheck {
  name = 'redis';

  constructor(private checkFn: () => Promise<boolean>) {}

  async execute(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const ok = await this.checkFn();
      const latencyMs = Date.now() - start;
      return {
        component: this.name,
        status: ok ? 'OK' : 'FAILING',
        message: ok ? `Connected (${latencyMs}ms)` : 'Connection check returned false',
        lastCheckedAt: new Date().toISOString(),
        metricValue: latencyMs,
      };
    } catch (error) {
      return {
        component: this.name,
        status: 'FAILING',
        message: error instanceof Error ? error.message : String(error),
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }
}

export class BrowserHealthCheck implements HealthCheck {
  name = 'browser';

  constructor(private checkFn: () => Promise<boolean>) {}

  async execute(): Promise<ComponentHealth> {
    try {
      const ok = await this.checkFn();
      return {
        component: this.name,
        status: ok ? 'OK' : 'FAILING',
        message: ok ? 'Browser process responsive' : 'Browser process not responsive',
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        component: this.name,
        status: 'FAILING',
        message: error instanceof Error ? error.message : String(error),
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }
}

export class GameHealthCheck implements HealthCheck {
  name = 'game';

  constructor(
    private checkFn: () => Promise<{ loaded: boolean; latencyMs?: number }>
  ) {}

  async execute(): Promise<ComponentHealth> {
    try {
      const result = await this.checkFn();
      if (!result.loaded) {
        return {
          component: this.name,
          status: 'FAILING',
          message: 'Game not loaded',
          lastCheckedAt: new Date().toISOString(),
        };
      }
      const latencyMs = result.latencyMs ?? 0;
      const status: HealthStatus =
        latencyMs > 1000 ? 'DEGRADED' : 'OK';
      return {
        component: this.name,
        status,
        message: `Game loaded, tick latency ${latencyMs}ms`,
        lastCheckedAt: new Date().toISOString(),
        metricValue: latencyMs,
      };
    } catch (error) {
      return {
        component: this.name,
        status: 'FAILING',
        message: error instanceof Error ? error.message : String(error),
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }
}

export class TelegramHealthCheck implements HealthCheck {
  name = 'telegram';

  constructor(private checkFn: () => Promise<boolean>) {}

  async execute(): Promise<ComponentHealth> {
    try {
      const ok = await this.checkFn();
      return {
        component: this.name,
        status: ok ? 'OK' : 'FAILING',
        message: ok ? 'Telegram bot reachable' : 'Telegram bot unreachable',
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        component: this.name,
        status: 'FAILING',
        message: error instanceof Error ? error.message : String(error),
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }
}

export class StaticHealthCheck implements HealthCheck {
  constructor(
    public readonly name: string,
    private status: HealthStatus,
    private message: string
  ) {}

  async execute(): Promise<ComponentHealth> {
    return {
      component: this.name,
      status: this.status,
      message: this.message,
      lastCheckedAt: new Date().toISOString(),
    };
  }
}
