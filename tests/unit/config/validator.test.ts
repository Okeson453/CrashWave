import { validateConfig, ConfigValidator, BettingConfig } from '../../../src/config/validator';

describe('validateConfig', () => {
  it('should validate and return config', () => {
    const config = validateConfig();
    expect(config).toBeDefined();
    expect(typeof config).toBe('object');
  });

  it('should not throw on valid environment', () => {
    expect(() => validateConfig()).not.toThrow();
  });
});

describe('ConfigValidator', () => {
  let validator: ConfigValidator;

  beforeEach(() => {
    validator = new ConfigValidator();
  });

  it('should validate stake constraints', () => {
    const result = validator.validateBettingConfig({ stake: 50 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Stake must be at least 100');
  });

  it('should reject negative stake', () => {
    const result = validator.validateBettingConfig({ stake: -100 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Stake must be positive');
  });

  it('should reject excessive stake', () => {
    const result = validator.validateBettingConfig({ stake: 2000000 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Stake exceeds maximum allowed');
  });

  it('should validate cashOutTarget constraints', () => {
    const low = validator.validateBettingConfig({ cashOutTarget: 1.0 });
    expect(low.valid).toBe(false);
    expect(low.errors).toContain('Cash-out target must be at least 1.01');

    const high = validator.validateBettingConfig({ cashOutTarget: 150 });
    expect(high.valid).toBe(false);
    expect(high.errors).toContain('Cash-out target exceeds maximum allowed');
  });

  it('should validate maxDailyEntries constraints', () => {
    const zero = validator.validateBettingConfig({ maxDailyEntries: 0 });
    expect(zero.valid).toBe(false);
    expect(zero.errors).toContain('Max daily entries must be positive');

    const excessive = validator.validateBettingConfig({ maxDailyEntries: 2000 });
    expect(excessive.valid).toBe(false);
    expect(excessive.errors).toContain('Max daily entries exceeds maximum allowed');
  });

  it('should validate maxDrawdownPercent constraints', () => {
    const zero = validator.validateBettingConfig({ maxDrawdownPercent: 0 });
    expect(zero.valid).toBe(false);
    expect(zero.errors).toContain('Max drawdown percent must be between 1 and 100');

    const excessive = validator.validateBettingConfig({ maxDrawdownPercent: 101 });
    expect(excessive.valid).toBe(false);
    expect(excessive.errors).toContain('Max drawdown percent must be between 1 and 100');
  });

  it('should accept valid config', () => {
    const result = validator.validateBettingConfig({
      stake: 500,
      cashOutTarget: 1.5,
      maxDailyEntries: 50,
      maxDrawdownPercent: 25,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should get and set current config', () => {
    const config: BettingConfig = { stake: 700, cashOutTarget: 1.3 };
    validator.setCurrentConfig(config);
    const current = validator.getCurrentConfig();
    expect(current).toEqual(config);
  });

  it('should return defensive copy of current config', () => {
    const config: BettingConfig = { stake: 700 };
    validator.setCurrentConfig(config);
    const current = validator.getCurrentConfig();
    current.stake = 999;
    expect(validator.getCurrentConfig().stake).toBe(700);
  });
});
