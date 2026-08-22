import { AppConfigSchema, SystemMode, BettingConfigSchema } from '../../../src/config/schema';

describe('AppConfigSchema', () => {
  const validConfig = {
    system: {
      mode: 'dry-run',
      logLevel: 'info',
      serviceName: 'test-service',
    },
    betting: {
      stakePerEntry: 700,
      cashOutTarget: 1.30,
      maxDailyEntries: 100,
      currencyUnit: 'units',
      dayBoundaryTimezone: 'UTC',
    },
    risk: {
      minBalanceForEntry: 700,
      balanceBuffer: 700,
      maxConsecutiveErrorsBeforeStop: 3,
      maxCashOutFailuresBeforeStop: 2,
      cooldownMs: 5000,
    },
    observation: {
      maxTickLatencyMs: 1000,
      minConfidenceForEntry: 'high',
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
      headless: false,
      viewportWidth: 1366,
      viewportHeight: 900,
      profileDirectory: './secrets/browser-profile',
      timeoutMs: 30000,
    },
    persistence: {
      databasePoolSize: 10,
      redisCommandTimeoutMs: 5000,
      redisReconnectIntervalMs: 3000,
    },
    health: {
      checkIntervalMs: 30000,
      degradationThreshold: 2,
      failureThreshold: 3,
    },
  };

  it('should validate a complete valid config', () => {
    const result = AppConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it('should reject negative stake', () => {
    const invalid = { ...validConfig, betting: { ...validConfig.betting, stakePerEntry: -100 } };
    const result = AppConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject zero cashOutTarget', () => {
    const invalid = { ...validConfig, betting: { ...validConfig.betting, cashOutTarget: 0 } };
    const result = AppConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject invalid mode', () => {
    const invalid = { ...validConfig, system: { ...validConfig.system, mode: 'invalid' } };
    const result = AppConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject maxDailyEntries above limit', () => {
    const invalid = { ...validConfig, betting: { ...validConfig.betting, maxDailyEntries: 2000 } };
    const result = AppConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should apply defaults for missing optional fields', () => {
    const minimal = {
      system: { mode: 'observe-only' },
      betting: {},
      risk: {},
      observation: {},
      telegram: {},
      browser: {},
      persistence: {},
      health: {},
    };
    const result = AppConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.betting.stakePerEntry).toBe(700);
      expect(result.data.betting.cashOutTarget).toBe(1.30);
    }
  });
});

describe('SystemMode', () => {
  it('should accept valid modes', () => {
    expect(SystemMode.safeParse('observe-only').success).toBe(true);
    expect(SystemMode.safeParse('dry-run').success).toBe(true);
    expect(SystemMode.safeParse('live').success).toBe(true);
    expect(SystemMode.safeParse('maintenance').success).toBe(true);
  });

  it('should reject invalid mode', () => {
    expect(SystemMode.safeParse('invalid').success).toBe(false);
  });
});

describe('BettingConfigSchema', () => {
  it('should validate valid betting config', () => {
    const result = BettingConfigSchema.safeParse({
      stakePerEntry: 700,
      cashOutTarget: 1.30,
      maxDailyEntries: 100,
    });
    expect(result.success).toBe(true);
  });

  it('should reject non-positive stake', () => {
    const result = BettingConfigSchema.safeParse({ stakePerEntry: 0 });
    expect(result.success).toBe(false);
  });
});
