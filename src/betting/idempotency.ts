import { getRedisClient, prefixKey } from '../persistence/redis-client';
import { getLogger } from '../observability/logger';
import { IdempotencyRecord, IdempotencyStatus, IdempotencyConfig, BetPlacementResult } from './types';

/**
 * IdempotencyKeyStore prevents duplicate bet placement by tracking
 * unique keys per round/bet. Keys are stored in Redis with TTL.
 *
 * Key format: `idempotency:{sessionId}:{roundId}`
 *
 * This ensures that even if the system retries a bet placement after
 * a network timeout, only one physical bet is ever placed per round.
 */
export class IdempotencyKeyStore {
  private readonly logger = getLogger();
  private readonly config: IdempotencyConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<IdempotencyConfig>) {
    this.config = {
      ttlMs: 300000, // 5 minutes default
      cleanupIntervalMs: 60000, // 1 minute default
      ...config,
    };
    this.startCleanupTimer();
  }

  /**
   * Generate a deterministic idempotency key for a session+round pair.
   */
  static generateKey(sessionId: string, roundId: string): string {
    return `${sessionId}:${roundId}`;
  }

  /**
   * Reserve a slot for a bet placement attempt.
   * Returns true if the reservation succeeded (no existing key).
   * Returns false if a key already exists for this round.
   */
  async reserve(sessionId: string, roundId: string, betId: string): Promise<boolean> {
    const key = IdempotencyKeyStore.generateKey(sessionId, roundId);
    const redis = getRedisClient();
    const prefixed = prefixKey(`idempotency:${key}`);

    try {
      // Use NX (only set if not exists) with TTL
      const result = await redis.set(
        prefixed,
        JSON.stringify({
          status: 'PENDING' as IdempotencyStatus,
          betId,
          roundId,
          sessionId,
          createdAt: new Date().toISOString(),
        }),
        'PX',
        this.config.ttlMs,
        'NX'
      );

      if (result === 'OK') {
        this.logger.info(
          { component: 'Idempotency', sessionId, roundId, betId },
          'Idempotency key reserved'
        );
        return true;
      }

      // Key already exists — check its status
      const existing = await this.getRecord(sessionId, roundId);
      if (existing) {
        this.logger.warn(
          {
            component: 'Idempotency',
            sessionId,
            roundId,
            existingStatus: existing.status,
            existingBetId: existing.betId,
          },
          'Idempotency key collision — duplicate bet attempt blocked'
        );
      }
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { component: 'Idempotency', sessionId, roundId, error: message },
        'Failed to reserve idempotency key'
      );
      // Fail-safe: if we can't verify idempotency, block the bet
      return false;
    }
  }

  /**
   * Mark a reserved key as completed (bet successfully placed).
   */
  async complete(
    sessionId: string,
    roundId: string,
    result: BetPlacementResult
  ): Promise<void> {
    const key = IdempotencyKeyStore.generateKey(sessionId, roundId);
    const redis = getRedisClient();
    const prefixed = prefixKey(`idempotency:${key}`);

    try {
      const existing = await redis.get(prefixed);
      if (!existing) {
        this.logger.warn(
          { component: 'Idempotency', sessionId, roundId },
          'Cannot complete — idempotency key not found (may have expired)'
        );
        return;
      }

      const record: IdempotencyRecord = {
        ...JSON.parse(existing),
        status: 'COMPLETED' as IdempotencyStatus,
        result,
      };

      await redis.set(prefixed, JSON.stringify(record), 'PX', this.config.ttlMs);
      this.logger.info(
        { component: 'Idempotency', sessionId, roundId },
        'Idempotency key marked as completed'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { component: 'Idempotency', sessionId, roundId, error: message },
        'Failed to complete idempotency key'
      );
    }
  }

  /**
   * Mark a reserved key as failed.
   */
  async fail(sessionId: string, roundId: string, reason: string): Promise<void> {
    const key = IdempotencyKeyStore.generateKey(sessionId, roundId);
    const redis = getRedisClient();
    const prefixed = prefixKey(`idempotency:${key}`);

    try {
      const existing = await redis.get(prefixed);
      if (!existing) {
        this.logger.warn(
          { component: 'Idempotency', sessionId, roundId },
          'Cannot mark failed — idempotency key not found'
        );
        return;
      }

      const record: IdempotencyRecord = {
        ...JSON.parse(existing),
        status: 'FAILED' as IdempotencyStatus,
        result: { success: false, error: reason },
      };

      // Use shorter TTL for failed keys so they can be retried sooner
      const failTtl = Math.min(this.config.ttlMs, 60000);
      await redis.set(prefixed, JSON.stringify(record), 'PX', failTtl);
      this.logger.info(
        { component: 'Idempotency', sessionId, roundId, reason },
        'Idempotency key marked as failed'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { component: 'Idempotency', sessionId, roundId, error: message },
        'Failed to mark idempotency key as failed'
      );
    }
  }

  /**
   * Mark a reserved key as UNKNOWN after an external side-effect with
   * uncertain outcome. Keys in UNKNOWN must not be retried; reconcile first.
   * Uses a longer TTL so the reservation blocks duplicate actions during reconciliation.
   */
  async markUnknown(sessionId: string, roundId: string, reason: string): Promise<void> {
    const key = IdempotencyKeyStore.generateKey(sessionId, roundId);
    const redis = getRedisClient();
    const prefixed = prefixKey(`idempotency:${key}`);

    try {
      const existing = await redis.get(prefixed);
      if (!existing) {
        this.logger.warn(
          { component: 'Idempotency', sessionId, roundId },
          'Cannot mark UNKNOWN — idempotency key not found'
        );
        return;
      }

      const record: IdempotencyRecord = {
        ...JSON.parse(existing),
        status: 'UNKNOWN' as IdempotencyStatus,
        result: { success: false, error: reason },
      };

      // Longer TTL: block re-dispatch while operator/reconciler resolves
      const unknownTtl = Math.max(this.config.ttlMs, 30 * 60 * 1000);
      await redis.set(prefixed, JSON.stringify(record), 'PX', unknownTtl);
      this.logger.warn(
        { component: 'Idempotency', sessionId, roundId, reason },
        'Idempotency key marked UNKNOWN — reconcile before any new action'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { component: 'Idempotency', sessionId, roundId, error: message },
        'Failed to mark idempotency key as UNKNOWN'
      );
    }
  }

  /**
   * Get the record for a given session+round.
   */
  async getRecord(sessionId: string, roundId: string): Promise<IdempotencyRecord | null> {
    const key = IdempotencyKeyStore.generateKey(sessionId, roundId);
    const redis = getRedisClient();
    const prefixed = prefixKey(`idempotency:${key}`);

    try {
      const data = await redis.get(prefixed);
      if (!data) return null;
      return JSON.parse(data) as IdempotencyRecord;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { component: 'Idempotency', sessionId, roundId, error: message },
        'Failed to read idempotency record'
      );
      return null;
    }
  }

  /**
   * Check if a key exists and is in a given status.
   */
  async hasStatus(
    sessionId: string,
    roundId: string,
    status: IdempotencyStatus
  ): Promise<boolean> {
    const record = await this.getRecord(sessionId, roundId);
    return record !== null && record.status === status;
  }

  /**
   * Check if a round has any idempotency key (regardless of status).
   */
  async exists(sessionId: string, roundId: string): Promise<boolean> {
    const record = await this.getRecord(sessionId, roundId);
    return record !== null;
  }

  /**
   * Release a key early (e.g., if bet was cancelled before placement).
   */
  async release(sessionId: string, roundId: string): Promise<void> {
    const key = IdempotencyKeyStore.generateKey(sessionId, roundId);
    const redis = getRedisClient();
    const prefixed = prefixKey(`idempotency:${key}`);

    try {
      await redis.del(prefixed);
      this.logger.info(
        { component: 'Idempotency', sessionId, roundId },
        'Idempotency key released'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { component: 'Idempotency', sessionId, roundId, error: message },
        'Failed to release idempotency key'
      );
    }
  }

  /**
   * Clean up expired keys. In Redis, keys with TTL expire automatically,
   * but this method can be used for explicit cleanup if needed.
   */
  async cleanup(): Promise<number> {
    // Redis handles TTL expiration automatically.
    // This method is a no-op but provided for interface completeness.
    return 0;
  }

  /**
   * Stop the cleanup timer.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private startCleanupTimer(): void {
    // Redis TTL handles expiration, but we keep the timer for potential
    // future use (e.g., scanning for orphaned keys).
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch((err) => {
        this.logger.error(
          { component: 'Idempotency', error: String(err) },
          'Cleanup error'
        );
      });
    }, this.config.cleanupIntervalMs);
  }
}

/**
 * In-memory idempotency store for testing and local development.
 * Not suitable for production — use Redis-backed store for distributed deployments.
 */
export class InMemoryIdempotencyStore extends IdempotencyKeyStore {
  private store = new Map<string, IdempotencyRecord>();

  constructor(config?: Partial<IdempotencyConfig>) {
    super(config);
  }

  override async reserve(sessionId: string, roundId: string, betId: string): Promise<boolean> {
    const key = IdempotencyKeyStore.generateKey(sessionId, roundId);
    if (this.store.has(key)) {
      return false;
    }
    this.store.set(key, {
      key,
      status: 'PENDING',
      betId,
      roundId,
      sessionId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    });
    return true;
  }

  override async complete(
    sessionId: string,
    roundId: string,
    result: BetPlacementResult
  ): Promise<void> {
    const key = IdempotencyKeyStore.generateKey(sessionId, roundId);
    const record = this.store.get(key);
    if (record) {
      record.status = 'COMPLETED';
      record.result = result;
    }
  }

  override async fail(sessionId: string, roundId: string, reason: string): Promise<void> {
    const key = IdempotencyKeyStore.generateKey(sessionId, roundId);
    const record = this.store.get(key);
    if (record) {
      record.status = 'FAILED';
      record.result = { success: false, error: reason };
    }
  }

  override async markUnknown(sessionId: string, roundId: string, reason: string): Promise<void> {
    const key = IdempotencyKeyStore.generateKey(sessionId, roundId);
    const record = this.store.get(key);
    if (record) {
      record.status = 'UNKNOWN';
      record.result = { success: false, error: reason };
    }
  }

  override async getRecord(sessionId: string, roundId: string): Promise<IdempotencyRecord | null> {
    const key = IdempotencyKeyStore.generateKey(sessionId, roundId);
    return this.store.get(key) ?? null;
  }

  override async release(sessionId: string, roundId: string): Promise<void> {
    const key = IdempotencyKeyStore.generateKey(sessionId, roundId);
    this.store.delete(key);
  }

  override async cleanup(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [key, record] of this.store) {
      if (new Date(record.expiresAt).getTime() < now) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.store.clear();
  }
}
