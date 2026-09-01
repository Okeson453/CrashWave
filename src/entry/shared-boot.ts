/**
 * Shared boot helpers for the personal-use monolith.
 *
 * Personal-use adaptation (spec §10.4): drops the JWT-secret assertion
 * (no JWT in personal use) and the `processRole` indirection (single
 * process). Redis is always optional.
 */

import { loadAndValidateConfig } from '../config/loader';
import type { AppConfig } from '../config/schema';
import { createPool } from '../persistence/client';
import { createRedisClient } from '../persistence/redis-client';
import { getLogger } from '../observability/logger';

export function bootConfig(): AppConfig {
  return loadAndValidateConfig();
}

export function bootPersistence(config: AppConfig, _opts?: { requireRedis?: boolean }): void {
  const databaseUrl =
    process.env.DATABASE_URL ?? process.env.APP_PERSISTENCE__CONNECTION_STRING;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const poolSize = Number(config.persistence?.databasePoolSize ?? 5);
  createPool({
    connectionString: databaseUrl,
    poolSize,
    idleTimeoutMillis: config.persistence?.idleTimeoutMillis,
    connectionTimeoutMillis: config.persistence?.connectionTimeoutMillis,
    queryTimeoutMillis: config.persistence?.queryTimeoutMillis,
  });
  getLogger().info({ component: 'Boot', poolSize }, 'Database pool sized');

  // Redis is optional in personal use; only attempt to connect if REDIS_URL is set.
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      createRedisClient({ url: redisUrl });
    } catch (e) {
      getLogger().warn({ component: 'Boot', error: String(e) }, 'Redis client init failed; continuing without Redis');
    }
  } else {
    getLogger().info({ component: 'Boot' }, 'Starting without Redis (REDIS_URL not set)');
  }
}
