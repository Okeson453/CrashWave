import Redis from 'ioredis';
import { getLogger } from '../observability/logger';
import { redisOptionsFromUrl } from './redis-options';

export interface RedisConfig {
  url: string;
  password?: string;
  commandTimeoutMs?: number;
  reconnectIntervalMs?: number;
  keyPrefix?: string;
}

let redisClient: Redis | null = null;

export function createRedisClient(config: RedisConfig): Redis {
  if (redisClient) {
    return redisClient;
  }

  const keyPrefix =
    config.keyPrefix ||
    process.env.REDIS_KEY_PREFIX ||
    undefined;

  redisClient = new Redis(
    redisOptionsFromUrl(config.url, {
      ...(config.password ? { password: config.password } : {}),
      ...(keyPrefix ? { keyPrefix } : {}),
      commandTimeout: config.commandTimeoutMs ?? 5000,
      reconnectOnError: (err) => {
        const msg = err.message.toLowerCase();
        return msg.includes('econnrefused') || msg.includes('connection lost');
      },
      retryStrategy: (times) => {
        const delay = Math.min(times * (config.reconnectIntervalMs ?? 3000), 30000);
        return delay;
      },
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    })
  );

  redisClient.on('connect', () => {
    getLogger().info({ component: 'Redis' }, 'Redis client connected');
  });

  redisClient.on('ready', () => {
    getLogger().info({ component: 'Redis' }, 'Redis client ready');
  });

  redisClient.on('error', (err) => {
    getLogger().error({ component: 'Redis' }, `Redis error: ${err.message}`);
  });

  redisClient.on('reconnecting', () => {
    getLogger().warn({ component: 'Redis' }, 'Redis reconnecting...');
  });

  redisClient.on('end', () => {
    getLogger().warn({ component: 'Redis' }, 'Redis connection closed');
  });

  return redisClient;
}

export function getRedisClient(): Redis {
  if (!redisClient) {
    throw new Error('Redis client not initialized. Call createRedisClient() first.');
  }
  return redisClient;
}

export function prefixKey(key: string, prefix?: string): string {
  const p = prefix || process.env.REDIS_KEY_PREFIX || 'crash:';
  return `${p}${key}`;
}

export async function redisHealthCheck(): Promise<boolean> {
  try {
    const client = getRedisClient();
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

export async function acquireMutex(
  key: string,
  ttlMs: number = 30000
): Promise<{ release: () => Promise<void> } | null> {
  const client = getRedisClient();
  const prefixed = prefixKey(`mutex:${key}`);
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const acquired = await client.set(prefixed, token, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') {
    return null;
  }

  return {
    release: async () => {
      const current = await client.get(prefixed);
      if (current === token) {
        await client.del(prefixed);
      }
    },
  };
}

export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    getLogger().info({ component: 'Redis' }, 'Redis client closed');
  }
}
