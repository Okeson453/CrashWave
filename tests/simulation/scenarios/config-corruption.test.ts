/**
 * Config Corruption Simulation Scenario
 * Tests validation and rejection of corrupted or invalid configuration values.
 */
import { validateConfig, ConfigValidator } from '../../../src/config/validator';

describe('Simulation: Config Corruption', () => {
  describe('stake validation', () => {
    it('should reject stake=0 as invalid', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ stake: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Stake must be positive');
    });

    it('should reject negative stake', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ stake: -100 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Stake must be positive');
    });

    it('should reject excessive stake', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ stake: 1000001 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Stake exceeds maximum allowed');
    });

    it('should accept valid stake', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ stake: 700 });
      expect(result.valid).toBe(true);
    });
  });

  describe('cash-out target validation', () => {
    it('should reject negative cash-out target', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ cashOutTarget: -1.5 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Cash-out target must be at least 1.01');
    });

    it('should reject cash-out target below 1.01', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ cashOutTarget: 1.00 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Cash-out target must be at least 1.01');
    });

    it('should reject excessively high cash-out target', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ cashOutTarget: 1000 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Cash-out target exceeds maximum allowed');
    });

    it('should accept valid cash-out target', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ cashOutTarget: 1.30 });
      expect(result.valid).toBe(true);
    });
  });

  describe('daily entries validation', () => {
    it('should reject excessive max daily entries', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ maxDailyEntries: 5000 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Max daily entries exceeds maximum allowed');
    });

    it('should reject max daily entries of 0', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ maxDailyEntries: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Max daily entries must be positive');
    });

    it('should reject negative max daily entries', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ maxDailyEntries: -10 });
      expect(result.valid).toBe(false);
    });
  });

  describe('drawdown validation', () => {
    it('should reject invalid drawdown percent', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ maxDrawdownPercent: 150 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Max drawdown percent must be between 1 and 100');
    });

    it('should reject drawdown percent of 0', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ maxDrawdownPercent: 0 });
      expect(result.valid).toBe(false);
    });

    it('should accept valid drawdown percent', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({ maxDrawdownPercent: 50 });
      expect(result.valid).toBe(true);
    });
  });

  describe('complete config validation', () => {
    it('should accept valid configuration', () => {
      const validator = new ConfigValidator();
      const result = validator.validateBettingConfig({
        stake: 700,
        cashOutTarget: 1.30,
        maxDailyEntries: 100,
        maxDrawdownPercent: 50,
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate complete config object', () => {
      const config = {
        betting: { stake: 700, cashOutTarget: 1.30, maxDailyEntries: 100 },
      };
      const result = validateConfig(config);
      expect(result.betting.stakePerEntry).toBeDefined();
    });

    it('should throw on invalid config object', () => {
      expect(() => {
        validateConfig({
          betting: { stake: 0, cashOutTarget: 1.30 },
        });
      }).toThrow('Configuration validation failed');
    });

    it('should preserve previous config on rejection', () => {
      const validator = new ConfigValidator();
      validator.setCurrentConfig({ stake: 700, cashOutTarget: 1.30, maxDailyEntries: 100 });
      const previous = validator.getCurrentConfig();
      validator.validateBettingConfig({ stake: 0 });
      const current = validator.getCurrentConfig();
      expect(current.stake).toBe(previous.stake);
      expect(current.cashOutTarget).toBe(previous.cashOutTarget);
    });
  });
});
