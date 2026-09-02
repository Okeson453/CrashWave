/**
 * DistributedMutex provides distributed locking via Redis (SET NX + PX).
 * Falls back to in-memory locking when Redis is unavailable (single-instance only).
 */

import Redis from 'ioredis';
import { redisOptionsFromUrl } from '../persistence/redis-options.js';
import { getLogger } from '../observability/logger';

export interface DistributedMutexOptions {
  redisUrl?: string;
  redisClient?: Redis;
  lockTimeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  keyPrefix?: string;
  /** When true, allow in-memory fallback if Redis is unreachable */
  allowInMemoryFallback?: boolean;
}

export interface LockHandle {
  release(): Promise<void>;
  /** Ownership token for diagnostics */
  token: string;
  resource: string;
}

export interface MutexMetrics {
  acquisitions: number;
  failures: number;
  contentions: number;
  releases: number;
  avgAcquisitionLatencyMs: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_COUNT = 5;
const DEFAULT_RETRY_DELAY_MS = 100;

export class DistributedMutex {
  private readonly redis: Redis | null;
  private readonly lockTimeoutMs: number;
  private readonly retryCount: number;
  private readonly retryDelayMs: number;
  private readonly keyPrefix: string;
  private readonly allowInMemoryFallback: boolean;
  private readonly localLocks: Map<string, { token: string; expiresAt: number }> = new Map();
  private readonly logger = getLogger();

  private metrics = {
    acquisitions: 0,
    failures: 0,
    contentions: 0,
    releases: 0,
    totalAcquisitionLatencyMs: 0,
  };

  constructor(options: DistributedMutexOptions = {}) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.keyPrefix = options.keyPrefix ?? process.env.REDIS_KEY_PREFIX ?? 'crash:';
    this.allowInMemoryFallback =
      options.allowInMemoryFallback ??
      (process.env.ALLOW_INMEMORY_MUTEX === 'true' ||
        process.env.NODE_ENV !== 'production');

    if (options.redisClient) {
      this.redis = options.redisClient;
    } else if (options.redisUrl) {
      this.redis = new Redis(
        redisOptionsFromUrl(options.redisUrl, {
          maxRetriesPerRequest: 2,
          lazyConnect: true,
          enableOfflineQueue: false,
        })
      );
      this.redis.on('error', (err) => {
        this.logger.warn({ component: 'DistributedMutex', error: err.message }, 'Redis client error');
      });
    } else {
      this.redis = null;
      const requireRedis =
        process.env.REQUIRE_REDIS === 'true' || process.env.NODE_ENV === 'production';
      if (requireRedis && process.env.ALLOW_INMEMORY_MUTEX !== 'true') {
        throw new Error(
          'DistributedMutex: Redis is required in production (set REDIS_URL or ALLOW_INMEMORY_MUTEX=true for single-instance only)'
        );
      }
      this.logger.warn(
        { component: 'DistributedMutex' },
        'No Redis configured — using in-memory locks (single-instance only)'
      );
    }
  }

  private lockKey(resource: string): string {
    return `${this.keyPrefix}mutex:${resource}`;
  }

  private generateToken(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Acquire a lock on the given resource.
   * Returns null if the lock cannot be obtained after retries.
   */
  async acquire(resource: string): Promise<LockHandle | null> {
    const start = Date.now();
    const token = this.generateToken();

    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      const handle = await this.tryAcquire(resource, token);
      if (handle) {
        const latency = Date.now() - start;
        this.metrics.acquisitions++;
        this.metrics.totalAcquisitionLatencyMs += latency;
        return handle;
      }

      this.metrics.contentions++;
      if (attempt < this.retryCount) {
        await this.sleep(this.retryDelayMs * Math.pow(1.5, attempt));
      }
    }

    this.metrics.failures++;
    this.logger.debug(
      { component: 'DistributedMutex', resource },
      'Failed to acquire lock after retries'
    );
    return null;
  }

  private async tryAcquire(resource: string, token: string): Promise<LockHandle | null> {
    // Prefer Redis when available
    if (this.redis) {
      try {
        if (this.redis.status !== 'ready') {
          await this.redis.connect().catch(() => undefined);
        }

        const key = this.lockKey(resource);
        const result = await this.redis.set(key, token, 'PX', this.lockTimeoutMs, 'NX');
        if (result === 'OK') {
          return this.createRedisHandle(resource, token, key);
        }
        return null;
      } catch (err) {
        this.logger.warn(
          { component: 'DistributedMutex', error: String(err) },
          'Redis lock acquisition failed; evaluating fallback'
        );
        if (!this.allowInMemoryFallback) {
          return null;
        }
        // fall through to in-memory
      }
    }

    if (!this.allowInMemoryFallback && !this.redis) {
      // P0-07: financial coordination must not proceed without Redis in production

      return null;
    }

    return this.tryAcquireLocal(resource, token);
  }

  private tryAcquireLocal(resource: string, token: string): LockHandle | null {
    const now = Date.now();
    const existing = this.localLocks.get(resource);

    // Clean expired local locks
    if (existing && existing.expiresAt <= now) {
      this.localLocks.delete(resource);
    } else if (existing) {
      return null;
    }

    this.localLocks.set(resource, {
      token,
      expiresAt: now + this.lockTimeoutMs,
    });

    return {
      token,
      resource,
      release: async () => {
        const current = this.localLocks.get(resource);
        if (current && current.token === token) {
          this.localLocks.delete(resource);
          this.metrics.releases++;
        }
      },
    };
  }

  private createRedisHandle(resource: string, token: string, key: string): LockHandle {
    return {
      token,
      resource,
      release: async () => {
        if (!this.redis) return;
        try {
          // Safe release: only delete if we still own the lock
          const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
              return redis.call("del", KEYS[1])
            else
              return 0
            end
          `;
          await this.redis.eval(script, 1, key, token);
          this.metrics.releases++;
        } catch (err) {
          this.logger.warn(
            { component: 'DistributedMutex', resource, error: String(err) },
            'Failed to release Redis lock'
          );
        }
      },
    };
  }

  getMetrics(): MutexMetrics {
    const avg =
      this.metrics.acquisitions > 0
        ? this.metrics.totalAcquisitionLatencyMs / this.metrics.acquisitions
        : 0;
    return {
      acquisitions: this.metrics.acquisitions,
      failures: this.metrics.failures,
      contentions: this.metrics.contentions,
      releases: this.metrics.releases,
      avgAcquisitionLatencyMs: Math.round(avg * 100) / 100,
    };
  }

  async disconnect(): Promise<void> {
    this.localLocks.clear();
    if (this.redis && !this.redis.options?.lazyConnect) {
      // Only quit if we created the client ourselves (not injected)
      // Injected clients are owned by the caller
    }
  }
}
