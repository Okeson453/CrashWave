/**
 * Hot prediction / feature cache — critical path reads only.
 * Design §1.4: precomputed features + hot prediction cache → <50ms prediction p99
 */

import { cacheHitTotal, cacheMissTotal } from './latency.js';

export interface CacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
  hits: number;
}

export class HotCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly name: string;
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

  constructor(name: string, defaultTtlMs = 5_000, maxEntries = 256) {
    this.name = name;
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      cacheMissTotal.inc({ cache: this.name });
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      cacheMissTotal.inc({ cache: this.name });
      return undefined;
    }
    entry.hits += 1;
    cacheHitTotal.inc({ cache: this.name });
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    if (this.store.size >= this.maxEntries) {
      // Evict oldest
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of this.store) {
        if (v.storedAt < oldestAt) {
          oldestAt = v.storedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.store.delete(oldestKey);
    }
    const now = Date.now();
    this.store.set(key, {
      value,
      storedAt: now,
      expiresAt: now + (ttlMs ?? this.defaultTtlMs),
      hits: 0,
    });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  stats(): { size: number; name: string } {
    return { size: this.store.size, name: this.name };
  }
}

/** Singleton caches for critical path */
export const predictionHotCache = new HotCache<{
  probability: number;
  confidence: number;
  regimeId: string | null;
  modelVersion: string;
  reasoning: readonly string[];
}>('prediction', 3_000, 64);

export const featureHotCache = new HotCache<Record<string, number>>('features', 10_000, 512);
