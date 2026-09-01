/**
 * Shared ioredis connection options.
 * Layerbase / managed Redis that route by TLS SNI require tls.servername
 * to match the database hostname (not an IP or proxy name).
 */
import type { RedisOptions } from 'ioredis';

function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

export function redisOptionsFromUrl(
  redisUrl: string,
  overrides: RedisOptions = {}
): RedisOptions {
  const url = new URL(redisUrl);
  const isTls = url.protocol === 'rediss:' || url.protocol === 'https:';

  // Keep username even when it is "default" — ACL AUTH requires it on many hosts.
  const username = url.username
    ? decodeURIComponent(url.username)
    : undefined;
  const password = url.password
    ? decodeURIComponent(url.password)
    : undefined;

  const base: RedisOptions = {
    host: url.hostname,
    port: parseInt(url.port || (isTls ? '6380' : '6379'), 10),
    username,
    password,
    db: parseInt((url.pathname || '/0').replace(/^\//, '') || '0', 10),
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,
    ...(isTls
      ? {
          tls: {
            servername: url.hostname,
            rejectUnauthorized: process.env.REDIS_TLS_INSECURE === 'true' ? false : true,
          },
        }
      : {}),
  };

  // Do not let explicit `undefined` overrides wipe URL-derived auth.
  return { ...base, ...definedOnly(overrides as Record<string, unknown>) } as RedisOptions;
}

export function attachRedisErrorHandler(
  client: { on: (event: string, fn: (err: Error) => void) => void },
  label: string
): void {
  client.on('error', (err) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getLogger } = require('../observability/logger') as {
        getLogger: () => { error: (o: object, m: string) => void };
      };
      getLogger().error({ component: label, error: err.message }, 'Redis client error');
    } catch {
      console.error(`[${label}] Redis error:`, err.message);
    }
  });
}
