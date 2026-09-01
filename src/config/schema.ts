import { z } from 'zod';

export const SystemMode = z.enum(['observe-only', 'dry-run', 'live', 'maintenance']);

export const LogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export const BettingConfigSchema = z.object({
  stakePerEntry: z.number().positive().default(700),
  cashOutTarget: z.number().positive().default(1.3),
  maxDailyEntries: z.number().int().positive().max(1000).default(500),
  currencyUnit: z.string().min(1).default('units'),
  dayBoundaryTimezone: z.string().min(1).default('UTC'),
});

export const DryRunConfigSchema = z.object({
  stake: z.number().positive().default(700),
  target: z.number().positive().default(1.3),
  initialVirtualBalance: z.number().nonnegative().default(10000),
  maxDailyVirtualTrades: z.number().int().nonnegative().default(500),
  minProbability: z.number().min(0).max(1).default(0.35),
  minConfidence: z.number().min(0).max(1).default(0.3),
});

export const RiskConfigSchema = z.object({
  minBalanceForEntry: z.number().nonnegative().default(700),
  balanceBuffer: z.number().nonnegative().default(700),
  maxConsecutiveErrorsBeforeStop: z.number().int().positive().default(3),
  maxCashOutFailuresBeforeStop: z.number().int().positive().default(2),
  cooldownMs: z.number().int().nonnegative().default(5000),
  minPredictionProbability: z.number().min(0).max(1).default(0.35),
  minPredictionConfidence: z.number().min(0).max(1).default(0.3),
  requirePredictionForLive: z.boolean().default(true),
});

export const ObservationConfigSchema = z.object({
  maxTickLatencyMs: z.number().int().positive().default(1000),
  minConfidenceForEntry: z.enum(['low', 'medium', 'high']).default('medium'),
  requireRoundId: z.boolean().default(true),
  latencyThresholdHealthyMs: z.number().int().positive().default(500),
  latencyThresholdDegradedMs: z.number().int().positive().default(1000),
});

export const TelegramConfigSchema = z.object({
  allowedUserIds: z.array(z.number()).default([]),
  verbosity: z.enum(['quiet', 'normal', 'verbose', 'debug']).default('normal'),
  sendRoundStart: z.boolean().default(false),
  sendRoundResult: z.boolean().default(true),
  sendHealthWarnings: z.boolean().default(true),
  rateLimitMessagesPerMinute: z.number().int().positive().default(30),
});

export const BrowserConfigSchema = z.object({
  headless: z.boolean().default(true),
  viewportWidth: z.number().int().positive().default(1366),
  viewportHeight: z.number().int().positive().default(900),
  profileDirectory: z.string().min(1).default('./secrets/browser-profile'),
  timeoutMs: z.number().int().positive().default(30000),
  stealthLevel: z.enum(['off', 'minimal', 'standard', 'full']).default('standard'),
});

export const PersistenceConfigSchema = z.object({
  databasePoolSize: z.number().int().positive().default(5),
  idleTimeoutMillis: z.number().int().positive().default(30000),
  connectionTimeoutMillis: z.number().int().positive().default(5000),
  queryTimeoutMillis: z.number().int().positive().default(15000),
});

export const HealthConfigSchema = z.object({
  checkIntervalMs: z.number().int().positive().default(30000),
  degradationThreshold: z.number().int().positive().default(2),
  failureThreshold: z.number().int().positive().default(3),
});

export const ProxyConfigSchema = z.object({
  enabled: z.boolean().default(false),
  server: z.string().nullable().default(null),
  username: z.string().nullable().default(null),
  password: z.string().nullable().default(null),
});

export const AppConfigSchema = z.object({
  system: z.object({
    mode: SystemMode.default('dry-run'),
    logLevel: LogLevel.default('info'),
    serviceName: z.string().min(1).default('personal-bc-automation'),
  }),
  betting: BettingConfigSchema,
  dryRun: DryRunConfigSchema.default({}),
  risk: RiskConfigSchema,
  observation: ObservationConfigSchema,
  telegram: TelegramConfigSchema,
  browser: BrowserConfigSchema,
  persistence: PersistenceConfigSchema,
  health: HealthConfigSchema,
  proxy: ProxyConfigSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type SystemModeType = z.infer<typeof SystemMode>;
export type LogLevelType = z.infer<typeof LogLevel>;

export function validateConfig(raw: unknown): AppConfig {
  return AppConfigSchema.parse(raw);
}
