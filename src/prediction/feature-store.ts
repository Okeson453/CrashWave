/**
 * V1.1 Feature Store — hot Redis cache + in-memory L1.
 * Design ref: Section 7, Section 20.4
 */

import { getLogger } from '../observability/logger.js';

export interface FeatureVector {
  roundId: string;
  features: Record<string, number>;
  updatedAt: string;
  version: string;
}

export class FeatureStore {
  private readonly logger = getLogger();
  private readonly l1 = new Map<string, FeatureVector>();
  private readonly maxL1 = 2_000;
  private redis: { hset: Function; hget: Function; expire: Function } | null = null;
  private readonly keyPrefix: string;

  constructor(opts?: { redis?: FeatureStore['redis']; keyPrefix?: string }) {
    this.redis = opts?.redis ?? null;
    this.keyPrefix = opts?.keyPrefix ?? 'cw:features:';
  }

  setRedis(client: FeatureStore['redis']): void {
    this.redis = client;
  }

  async put(vector: FeatureVector): Promise<void> {
    this.l1.set(vector.roundId, vector);
    if (this.l1.size > this.maxL1) {
      const first = this.l1.keys().next().value;
      if (first) this.l1.delete(first);
    }
    if (this.redis) {
      try {
        const key = this.keyPrefix + vector.roundId;
        await this.redis.hset(key, {
          payload: JSON.stringify(vector),
          updatedAt: vector.updatedAt,
        });
        await this.redis.expire(key, 86_400);
      } catch (err) {
        this.logger.warn(
          {
            component: 'FeatureStore',
            error: err instanceof Error ? err.message : String(err),
          },
          'Redis feature put failed; L1 retained'
        );
      }
    }
  }

  async get(roundId: string): Promise<FeatureVector | null> {
    const local = this.l1.get(roundId);
    if (local) return local;
    if (!this.redis) return null;
    try {
      const raw = await this.redis.hget(this.keyPrefix + roundId, 'payload');
      if (!raw || typeof raw !== 'string') return null;
      const parsed = JSON.parse(raw) as FeatureVector;
      this.l1.set(roundId, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  /** Incremental update: merge delta into existing or create new */
  async updateIncremental(
    roundId: string,
    delta: Record<string, number>,
    version = '1'
  ): Promise<FeatureVector> {
    const existing = (await this.get(roundId)) ?? {
      roundId,
      features: {},
      updatedAt: new Date().toISOString(),
      version,
    };
    const merged: FeatureVector = {
      ...existing,
      features: { ...existing.features, ...delta },
      updatedAt: new Date().toISOString(),
      version,
    };
    await this.put(merged);
    return merged;
  }

  size(): number {
    return this.l1.size;
  }
}
