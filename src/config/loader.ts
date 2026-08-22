import { readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { AppConfig, AppConfigSchema } from './schema';
import { DEFAULT_CONFIG } from './defaults';

function loadYamlFile(path: string): Record<string, unknown> {
  try {
    const content = readFileSync(path, 'utf-8');
    return yaml.load(content) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`Failed to parse YAML config at ${path}: ${(err as Error).message}`);
  }
}

function parseEnvValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value === 'undefined') return undefined;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function loadEnvOverrides(prefix = 'APP_'): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || value === undefined) continue;
    const path = key
      .slice(prefix.length)
      .toLowerCase()
      .replace(/__/g, '.')
      .replace(/_/g, '.');
    setNestedValue(overrides, path, parseEnvValue(value));
  }
  return overrides;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      key in result &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      typeof source[key] === 'object' &&
      source[key] !== null &&
      !Array.isArray(source[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function loadConfig(configPath?: string): unknown {
  const yamlPath = configPath || join(process.cwd(), 'config.yaml');
  const yamlConfig = loadYamlFile(yamlPath);
  const envConfig = loadEnvOverrides();
  const merged = deepMerge(
    deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, yamlConfig),
    envConfig
  );
  return merged;
}

export function loadAndValidateConfig(configPath?: string): AppConfig {
  const raw = loadConfig(configPath);
  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }
  return applyTenantEnvOverrides(parsed.data);
}

/**
 * When TENANT_ID is set, Control Plane injects fixed plan parameters via env.
 * Single-tenant deployments are unaffected.
 */
export function applyTenantEnvOverrides(config: AppConfig): AppConfig {
  if (!process.env.TENANT_ID) return config;

  const mode = process.env.MODE ?? process.env.SYSTEM_MODE;
  const stake = process.env.CUSTOM_STAKE ?? process.env.FIXED_STAKE;
  const target = process.env.FIXED_TARGET;
  const maxEntries = process.env.MAX_DAILY_ENTRIES;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  return {
    ...config,
    system: {
      ...config.system,
      mode: (mode as AppConfig['system']['mode']) ?? config.system.mode,
    },
    betting: {
      ...config.betting,
      stakePerEntry: stake != null ? parseInt(stake, 10) : config.betting.stakePerEntry,
      cashOutTarget: target != null ? parseFloat(target) : config.betting.cashOutTarget,
      maxDailyEntries:
        maxEntries != null ? parseInt(maxEntries, 10) : config.betting.maxDailyEntries,
    },
    telegram: {
      ...config.telegram,
      allowedUserIds: chatId
        ? [chatId]
        : config.telegram.allowedUserIds,
    },
  };
}
