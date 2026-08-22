import { z } from 'zod';

export const SystemMode = z.enum([
  'observe-only',
  'dry-run',
  'live',
  'maintenance',
]);

export const LogLevel = z.enum([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
]);

export const BettingConfigSchema = z.object({
  stakePerEntry: z.number().positive().default(700),
  cashOutTarget: z.number().positive().default(1.30),
  maxDailyEntries: z.number().int().positive().max(1000).default(100),
  currencyUnit: z.string().min(1).default('units'),
  dayBoundaryTimezone: z.string().min(1).default('UTC'),
});

export const RiskConfigSchema = z.object({
  minBalanceForEntry: z.number().nonnegative().default(700),
  balanceBuffer: z.number().nonnegative().default(700),
  maxConsecutiveErrorsBeforeStop: z.number().int().positive().default(3),
  maxCashOutFailuresBeforeStop: z.number().int().positive().default(2),
  cooldownMs: z.number().int().nonnegative().default(5000),
  /** Minimum model probability required when a prediction signal is present (live/dry-run) */
  minPredictionProbability: z.number().min(0).max(1).default(0.35),
  /** Minimum model confidence required when a prediction signal is present */
  minPredictionConfidence: z.number().min(0).max(1).default(0.3),
  /** When true, live mode rejects entry if prediction history is insufficient */
  requirePredictionForLive: z.boolean().default(true),
});

export const ObservationConfigSchema = z.object({
  maxTickLatencyMs: z.number().int().positive().default(1000),
  minConfidenceForEntry: z.enum(['low', 'medium', 'high']).default('high'),
  requireRoundId: z.boolean().default(true),
  latencyThresholdHealthyMs: z.number().int().positive().default(500),
  latencyThresholdDegradedMs: z.number().int().positive().default(1000),
});

export const TelegramConfigSchema = z.object({
  allowedUserIds: z.array(z.string().or(z.number())).default([]),
  verbosity: z.enum(['quiet', 'normal', 'verbose', 'debug']).default('normal'),
  sendRoundStart: z.boolean().default(false),
  sendRoundResult: z.boolean().default(true),
  sendHealthWarnings: z.boolean().default(true),
  rateLimitMessagesPerMinute: z.number().int().positive().default(30),
});

export const BrowserStealthSchema = z.object({
  enabled: z.boolean().default(true),
  preferNonHeadlessForLive: z.boolean().default(true),
  disableAutomationControlled: z.boolean().default(true),
  canvasNoise: z.boolean().default(true),
  webglNoise: z.boolean().default(true),
  audioNoise: z.boolean().default(true),
});

export const BrowserInteractionSchema = z.object({
  humanize: z.boolean().default(true),
  minActionDelayMs: z.number().int().nonnegative().default(70),
  maxActionDelayMs: z.number().int().positive().default(450),
  mouseBezier: z.boolean().default(true),
  typeInsteadOfFill: z.boolean().default(true),
  requirePrecedingMouseMove: z.boolean().default(true),
});

export const BrowserSessionSchema = z.object({
  maxAgeHours: z.number().positive().default(12),
  maxContinuousActiveMinutes: z.number().positive().default(150),
  rotationJitterMinutes: z.number().nonnegative().default(25),
  warmUpNavigation: z.boolean().default(true),
  quarantineOnChallenge: z.boolean().default(true),
  minWarmStandbyProfiles: z.number().int().nonnegative().default(1),
});

export const BrowserNetworkSchema = z.object({
  proxyServer: z.string().nullable().default(null),
  proxyMatchTimezone: z.boolean().default(true),
});

export const BrowserConfigSchema = z.object({
  headless: z.boolean().default(false),
  viewportWidth: z.number().int().positive().default(1366),
  viewportHeight: z.number().int().positive().default(900),
  profileDirectory: z.string().min(1).default('./secrets/browser-profile'),
  timeoutMs: z.number().int().positive().default(30000),
  stealth: BrowserStealthSchema.default({}),
  interaction: BrowserInteractionSchema.default({}),
  session: BrowserSessionSchema.default({}),
  network: BrowserNetworkSchema.default({}),
  canaryIntervalMs: z.number().int().positive().default(30000),
  unknownReconciliationTimeoutMs: z.number().int().positive().default(300000),
});

export const PersistenceConfigSchema = z.object({
  databasePoolSize: z.number().int().positive().default(10),
  redisCommandTimeoutMs: z.number().int().positive().default(5000),
  redisReconnectIntervalMs: z.number().int().positive().default(3000),
});

export const HealthConfigSchema = z.object({
  checkIntervalMs: z.number().int().positive().default(30000),
  degradationThreshold: z.number().int().positive().default(2),
  failureThreshold: z.number().int().positive().default(3),
});


export const ProxyConfigSchema = z.object({
  enabled: z.boolean().default(false),
  server: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  sticky: z.boolean().default(true),
  rotationMode: z.enum(['never', 'on-profile-recreate', 'daily']).default('never'),
  provider: z.enum(['generic', 'brightdata', 'oxylabs', 'iproyal', 'custom']).default('generic'),
}).refine((data) => !data.enabled || !!data.server, {
  message: 'proxy.server is required when proxy.enabled = true',
});

export const VelocityConfigSchema = z.object({
  enabled: z.boolean().default(true),
  minActionIntervalMs: z.number().int().min(1000).default(8000),
  maxActionIntervalMs: z.number().int().min(2000).default(25000),
  maxActionsPerMinute: z.number().int().min(1).default(4),
  maxActionsPerHour: z.number().int().min(1).default(60),
  idleProbability: z.number().min(0).max(0.4).default(0.12),
  minIdleMs: z.number().int().default(30000),
  maxIdleMs: z.number().int().default(180000),
  cashOutJitterMs: z.number().int().min(0).default(180),
});

export const BehavioralConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mouseStepsMin: z.number().int().default(8),
  mouseStepsMax: z.number().int().default(22),
  mouseOvershootPx: z.number().int().default(12),
  clickDelayMinMs: z.number().int().default(35),
  clickDelayMaxMs: z.number().int().default(130),
  typeDelayMinMs: z.number().int().default(30),
  typeDelayMaxMs: z.number().int().default(95),
});

export const TelemetryNoiseConfigSchema = z.object({
  enabled: z.boolean().default(false),
  cashOutTargetNoise: z.number().min(0).max(0.05).default(0.015),
  skipEntryProbability: z.number().min(0).max(0.15).default(0.04),
  delayedCashOutProbability: z.number().min(0).max(0.1).default(0.03),
});

export const SessionConsistencyConfigSchema = z.object({
  maxSessionAgeHours: z.number().positive().default(72),
  requireAuthOnStart: z.boolean().default(true),
  pauseOnAuthLoss: z.boolean().default(true),
  profileSticky: z.boolean().default(true),
});



// ─── Spec Upgrade Schemas (protocol / latency / capital / stealth) ───────────

export const Ja4ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  profileId: z.string().default('chrome-126-win11'),
});

export const NativeSocketConfigSchema = z.object({
  enabled: z.boolean().default(true),
  noDelay: z.boolean().default(true),
  sendBufferSize: z.number().int().positive().default(262144),
  recvBufferSize: z.number().int().positive().default(262144),
  heartbeatIntervalMs: z.number().int().nonnegative().default(15000),
  safetyMarginMs: z.number().int().nonnegative().default(15),
  preSendEnabled: z.boolean().default(true),
});

export const PayloadIngestionConfigSchema = z.object({
  circuitBreakerThreshold: z.number().int().positive().default(8),
  enabled: z.boolean().default(true),
});

export const ProvablyFairConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxHashFailures: z.number().int().positive().default(3),
  kellyLambda: z.number().min(0).max(1).default(0.25),
  kellyMaxFraction: z.number().min(0).max(1).default(0.05),
  volatilitySigmaThreshold: z.number().positive().default(3),
  /** Ultra-low multiplier mode for turnover / bonus harvesting */
  turnoverMode: z.boolean().default(false),
  turnoverTarget: z.number().positive().default(1.01),
});

export const CapitalIsolationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  hotBuffer: z.number().nonnegative().default(5000),
  withdrawThreshold: z.number().nonnegative().default(8000),
  minWithdrawAmount: z.number().nonnegative().default(1000),
  sweepCooldownMs: z.number().int().nonnegative().default(300000),
  maxDrawdownAbs: z.number().nonnegative().default(5000),
  maxDrawdownPct: z.number().min(0).max(1).default(0.25),
  panicBalanceFloor: z.number().nonnegative().default(500),
  watchdogEnabled: z.boolean().default(true),
  watchdogPollIntervalMs: z.number().int().positive().default(10000),
});

export const StealthUpgradeConfigSchema = z.object({
  hardwareProfileId: z.string().default('win11-rtx3060-chrome'),
  biomechanicalInput: z.boolean().default(true),
  /** When true, browser is only used for handshake; execution uses native socket */
  protocolOffload: z.boolean().default(true),
});


export const SettlementConfigSchema = z.object({
  enabled: z.boolean().default(true),
  driftThreshold: z.number().nonnegative().default(0.0001),
  driftPollIntervalMs: z.number().int().positive().default(30000),
  driftEnabled: z.boolean().default(true),
  evidenceProvider: z.enum(['null', 'rest_history']).default('null'),
  evidenceBaseUrl: z.string().optional(),
});

export const SpecUpgradeConfigSchema = z.object({
  ja4: Ja4ConfigSchema.default({}),
  nativeSocket: NativeSocketConfigSchema.default({}),
  payloadIngestion: PayloadIngestionConfigSchema.default({}),
  provablyFair: ProvablyFairConfigSchema.default({}),
  capital: CapitalIsolationConfigSchema.default({}),
  stealth: StealthUpgradeConfigSchema.default({}),
  settlement: SettlementConfigSchema.default({}),
});

export const AppConfigSchema = z.object({
  specUpgrade: SpecUpgradeConfigSchema.default({}),
  system: z.object({
    mode: SystemMode.default('dry-run'),
    logLevel: LogLevel.default('info'),
    serviceName: z.string().min(1).default('bc-game-crash-automation'),
  }),
  betting: BettingConfigSchema,
  risk: RiskConfigSchema,
  observation: ObservationConfigSchema,
  telegram: TelegramConfigSchema,
  browser: BrowserConfigSchema,
  persistence: PersistenceConfigSchema,
  health: HealthConfigSchema,
  proxy: ProxyConfigSchema.default({}),
  velocity: VelocityConfigSchema.default({}),
  behavioral: BehavioralConfigSchema.default({}),
  telemetryNoise: TelemetryNoiseConfigSchema.default({}),
  sessionConsistency: SessionConsistencyConfigSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type SystemModeType = z.infer<typeof SystemMode>;
export type LogLevelType = z.infer<typeof LogLevel>;
export type BettingConfig = z.infer<typeof BettingConfigSchema>;
export type RiskConfig = z.infer<typeof RiskConfigSchema>;
export type ObservationConfig = z.infer<typeof ObservationConfigSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type PersistenceConfig = z.infer<typeof PersistenceConfigSchema>;
export type HealthConfig = z.infer<typeof HealthConfigSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type VelocityConfig = z.infer<typeof VelocityConfigSchema>;
export type BehavioralConfig = z.infer<typeof BehavioralConfigSchema>;
export type TelemetryNoiseConfig = z.infer<typeof TelemetryNoiseConfigSchema>;
export type SessionConsistencyConfig = z.infer<typeof SessionConsistencyConfigSchema>;
export type SpecUpgradeConfig = z.infer<typeof SpecUpgradeConfigSchema>;
export type SettlementConfig = z.infer<typeof SettlementConfigSchema>;

/**
 * Validates a raw configuration object against the AppConfig schema.
 * Returns the validated config or throws a ZodError with detailed messages.
 */
export function validateConfig(raw: unknown): AppConfig {
  return AppConfigSchema.parse(raw);
}
