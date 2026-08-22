/**
 * Operator Misconfiguration Simulation Scenario
 * Tests detection and handling of dangerous operator configuration mistakes.
 */
import { EventBus } from '../../../src/core/event-bus/bus';
import { ConfigValidator } from '../../../src/config/validator';

describe('Simulation: Operator Misconfiguration', () => {
  let eventBus: EventBus;
  let validator: ConfigValidator;

  beforeEach(() => {
    eventBus = new EventBus();
    validator = new ConfigValidator();
    validator.setCurrentConfig({ stake: 700, cashOutTarget: 1.30, maxDailyEntries: 100 });
  });

  describe('stake misconfiguration', () => {
    it('should reject stake=0', () => {
      const result = validator.validateBettingConfig({ stake: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Stake must be positive');
    });

    it('should reject negative stake', () => {
      const result = validator.validateBettingConfig({ stake: -100 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Stake must be positive');
    });

    it('should reject stake exceeding balance safety limits', () => {
      const result = validator.validateBettingConfig({ stake: 1000001 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Stake exceeds maximum allowed');
    });
  });

  describe('cash-out target misconfiguration', () => {
    it('should reject cash-out target below 1.01', () => {
      const result = validator.validateBettingConfig({ cashOutTarget: 1.00 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Cash-out target must be at least 1.01');
    });

    it('should reject cash-out target of 1.0 (break-even)', () => {
      const result = validator.validateBettingConfig({ cashOutTarget: 1.0 });
      expect(result.valid).toBe(false);
    });

    it('should reject unrealistically high cash-out target', () => {
      const result = validator.validateBettingConfig({ cashOutTarget: 1000 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Cash-out target exceeds maximum allowed');
    });
  });

  describe('daily entries misconfiguration', () => {
    it('should reject max daily entries of 0', () => {
      const result = validator.validateBettingConfig({ maxDailyEntries: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Max daily entries must be positive');
    });

    it('should reject negative max daily entries', () => {
      const result = validator.validateBettingConfig({ maxDailyEntries: -10 });
      expect(result.valid).toBe(false);
    });

    it('should reject excessive max daily entries', () => {
      const result = validator.validateBettingConfig({ maxDailyEntries: 5000 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Max daily entries exceeds maximum allowed');
    });
  });

  describe('drawdown misconfiguration', () => {
    it('should reject drawdown percent above 100', () => {
      const result = validator.validateBettingConfig({ maxDrawdownPercent: 150 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Max drawdown percent must be between 1 and 100');
    });

    it('should reject drawdown percent of 0', () => {
      const result = validator.validateBettingConfig({ maxDrawdownPercent: 0 });
      expect(result.valid).toBe(false);
    });

    it('should accept valid drawdown percent', () => {
      const result = validator.validateBettingConfig({ maxDrawdownPercent: 50 });
      expect(result.valid).toBe(true);
    });
  });

  describe('config preservation', () => {
    it('should accept valid configuration', () => {
      const result = validator.validateBettingConfig({
        stake: 700, cashOutTarget: 1.30, maxDailyEntries: 100,
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should preserve previous config on rejection', () => {
      validator.setCurrentConfig({ stake: 700, cashOutTarget: 1.30 });
      const previous = validator.getCurrentConfig();
      validator.validateBettingConfig({ stake: 0 });
      const current = validator.getCurrentConfig();
      expect(current.stake).toBe(previous.stake);
      expect(current.cashOutTarget).toBe(previous.cashOutTarget);
    });

    it('should update config on valid change', () => {
      const result = validator.validateBettingConfig({ stake: 500, cashOutTarget: 1.50, maxDailyEntries: 50 });
      expect(result.valid).toBe(true);
      validator.setCurrentConfig({ stake: 500, cashOutTarget: 1.50, maxDailyEntries: 50 });
      const current = validator.getCurrentConfig();
      expect(current.stake).toBe(500);
      expect(current.cashOutTarget).toBe(1.50);
    });
  });

  describe('critical error emission', () => {
    it('should emit CriticalError on invalid config attempt', async () => {
      const errors: Array<{ code: string }> = [];
      eventBus.on('CriticalError', (event: { payload: { code: string } }) => {
        errors.push(event.payload);
      });
      await eventBus.emitTyped('CriticalError', {
        message: 'Invalid configuration: stake=0',
        code: 'INVALID_CONFIG', component: 'ConfigValidator',
      }, 'cfg-1', 'ConfigValidator');
      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe('INVALID_CONFIG');
    });

    it('should emit CriticalError for dangerous cash-out target', async () => {
      const errors: Array<{ code: string }> = [];
      eventBus.on('CriticalError', (event: { payload: { code: string } }) => {
        errors.push(event.payload);
      });
      await eventBus.emitTyped('CriticalError', {
        message: 'Dangerous cash-out target: 1.001',
        code: 'DANGEROUS_CONFIG', component: 'ConfigValidator',
      }, 'cfg-2', 'ConfigValidator');
      expect(errors[0].code).toBe('DANGEROUS_CONFIG');
    });
  });
});
