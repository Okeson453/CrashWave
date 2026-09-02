import { AppConfig } from './schema';

/**
 * Default configuration for personal-use BC.Game Crash automation.
 *
 * All values are sensible defaults for a single-operator dry-run session.
 * Override via config.yaml or APP_* environment variables.
 */
export const DEFAULT_CONFIG: AppConfig = {
  system: {
    mode: 'dry-run',
    logLevel: 'info',
    serviceName: 'personal-bc-automation',
  },
  betting: {
    stakePerEntry: 700,
    cashOutTarget: 1.30,
    maxDailyEntries: 500,
    currencyUnit: 'units',
    dayBoundaryTimezone: 'UTC',
  },
  dryRun: {
    stake: 700,
    target: 1.30,
    initialVirtualBalance: 10000,
    maxDailyVirtualTrades: 500,
    minProbability: 0.35,
    minConfidence: 0.30,
  },
  risk: {
    minBalanceForEntry: 700,
    balanceBuffer: 700,
    maxConsecutiveErrorsBeforeStop: 3,
    maxCashOutFailuresBeforeStop: 2,
    cooldownMs: 5000,
    minPredictionProbability: 0.35,
    minPredictionConfidence: 0.30,
    requirePredictionForLive: true,
  },
  observation: {
    maxTickLatencyMs: 1000,
    minConfidenceForEntry: 'medium',
    requireRoundId: true,
    latencyThresholdHealthyMs: 500,
    latencyThresholdDegradedMs: 1000,
  },
  telegram: {
    allowedUserIds: [],
    verbosity: 'normal',
    sendRoundStart: false,
    sendRoundResult: true,
    sendHealthWarnings: true,
    rateLimitMessagesPerMinute: 30,
  },
  browser: {
    headless: true,
    viewportWidth: 1366,
    viewportHeight: 900,
    profileDirectory: './secrets/browser-profile',
    timeoutMs: 30000,
    stealthLevel: 'standard',
  },
  persistence: {
    databasePoolSize: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    queryTimeoutMillis: 15000,
  },
  health: {
    checkIntervalMs: 30000,
    degradationThreshold: 2,
    failureThreshold: 3,
  },
  proxy: {
    enabled: false,
    server: null,
    username: null,
    password: null,
    pool: [],
  },
};