/**
 * Load secrets from Docker secret files (*_FILE env vars) with env fallback.
 * Never logs secret values.
 */

import { readFileSync, existsSync } from 'fs';

/**
 * Resolve a secret value from:
 * 1. process.env[NAME_FILE] path contents
 * 2. process.env[NAME]
 */
export function resolveSecret(name: string): string | undefined {
  const fileEnv = process.env[`${name}_FILE`];
  if (fileEnv && existsSync(fileEnv)) {
    try {
      return readFileSync(fileEnv, 'utf-8').trim();
    } catch {
      return undefined;
    }
  }
  return process.env[name];
}

/** Apply common secret file env mappings into process.env if missing */
export function hydrateSecretsFromFiles(): void {
  const keys = [
    'DATABASE_URL',
    'REDIS_URL',
    'TELEGRAM_BOT_TOKEN',
    'ENCRYPTION_KEY',
    'TELEGRAM_OPERATOR_CHAT_ID',
  ];
  for (const key of keys) {
    if (!process.env[key]) {
      const v = resolveSecret(key);
      if (v) process.env[key] = v;
    }
  }
}
