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

export const BehavioralConfigSchema = z.object({
  enabled: z.boolean().default(true),
  minActionDelayMs: z.number().int().nonnegative().default(80),
  maxActionDelayMs: z.number().int().nonnegative().default(250),
  typingWpmMin: z.number().int().positive().default(180),
  typingWpmMax: z.number().int().positive().default(320),
  mouseJitterPx: z.number().int().nonnegative().default(3),
  scrollProbability: z.number().min(0).max(1).default(0.15),
  clickDelayMinMs: z.number().int().nonnegative().default(50),
  clickDelayMaxMs: z.number().int().nonnegative().default(180),
  mouseStepsMin: z.number().int().positive().default(12),
  mouseStepsMax: z.number().int().positive().default(28),
  mouseOvershootPx: z.number().int().nonnegative().default(6),
  typeDelayMinMs: z.number().int().nonnegative().default(40),
  typeDelayMaxMs: z.number().int().nonnegative().default(140),
});

export const SessionConsistencyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  checkIntervalMs: z.number().int().positive().default(15000),
  maxConsecutiveFailures: z.number().int().positive().default(3),
  autoRecover: z.boolean().default(true),
  requireAuthOnStart: z.boolean().default(true),
  maxSessionAgeHours: z.number().int().positive().default(12),
  pauseOnAuthLoss: z.boolean().default(true),
});

export const ProxyPoolEntrySchema = z.object({
  server: z.string().min(1),
  username: z.string().nullable().default(null),
  password: z.string().nullable().default(null),
});

export const ProxyConfigSchema = z.object({
  enabled: z.boolean().default(false),
  server: z.string().nullable().default(null),
  username: z.string().nullable().default(null),
  password: z.string().nullable().default(null),
  pool: z.array(ProxyPoolEntrySchema).default([]),
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

export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type BehavioralConfig = z.infer<typeof BehavioralConfigSchema>;
export type SessionConsistencyConfig = z.infer<typeof SessionConsistencyConfigSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type PersistenceConfig = z.infer<typeof PersistenceConfigSchema>;
export type HealthConfig = z.infer<typeof HealthConfigSchema>;

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
