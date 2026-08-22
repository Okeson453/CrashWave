/**
 * Proxy & network layer — sticky residential/ISP proxy resolution (enterprise detection layer).
 */

import { ProxyConfig } from '../config/schema';
import { getLogger } from '../observability/logger';
import { metricCollector } from '../observability/metrics/collectors';

export interface ResolvedProxy {
  server: string;
  username?: string;
  password?: string;
  stickySessionId?: string;
}

export class ProxyManager {
  private readonly logger = getLogger();
  private current: ResolvedProxy | null = null;
  private sessionId: string;

  constructor(private readonly config: ProxyConfig) {
    this.sessionId = `sticky-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async resolve(): Promise<ResolvedProxy | null> {
    if (!this.config.enabled || !this.config.server) {
      return null;
    }

    if (this.config.sticky && this.current) {
      return this.current;
    }

    const resolved: ResolvedProxy = {
      server: this.config.server,
      username: this.config.username,
      password: this.config.password,
      stickySessionId: this.config.sticky ? this.sessionId : undefined,
    };

    if (this.config.sticky && this.config.provider !== 'generic') {
      if (resolved.username && !resolved.username.includes('-session-')) {
        resolved.username = `${resolved.username}-session-${this.sessionId}`;
      }
    }

    this.current = resolved;
    this.logger.info(
      { component: 'ProxyManager', provider: this.config.provider, sticky: this.config.sticky },
      'Proxy resolved'
    );
    (metricCollector as any).recordProxyResolved?.(this.config.provider);

    return resolved;
  }

  getCurrent(): ResolvedProxy | null {
    return this.current;
  }

  async rotate(): Promise<ResolvedProxy | null> {
    if (this.config.rotationMode === 'never') {
      this.logger.warn({ component: 'ProxyManager' }, 'Rotation requested but mode=never');
      return this.current;
    }
    this.current = null;
    this.sessionId = `sticky-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return this.resolve();
  }

  /** Playwright-compatible proxy option */
  toPlaywrightProxy(): { server: string; username?: string; password?: string } | undefined {
    if (!this.current) return undefined;
    return {
      server: this.current.server,
      username: this.current.username,
      password: this.current.password,
    };
  }
}
