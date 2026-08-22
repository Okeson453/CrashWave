import { AppConfig } from './schema';
import { loadAndValidateConfig } from './loader';
/**
 * ConfigValidator validates betting configuration changes from operators.
 * Prevents invalid configurations from being applied to the system.
 */

export interface BettingConfig {
  stake?: number;
  cashOutTarget?: number;
  maxDailyEntries?: number;
  maxDrawdownPercent?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates application configuration from environment variables.
 * If a config object is provided, validates that instead.
 * Returns the validated config or throws on validation failure.
 */
export function validateConfig(config?: Record<string, unknown>): AppConfig {
  if (config) {
    const validator = new ConfigValidator();
    const betting = (config.betting as BettingConfig) || {};
    const result = validator.validateBettingConfig(betting);
    if (!result.valid) {
      throw new Error(`Configuration validation failed: ${result.errors.join(', ')}`);
    }
    // Full schema validation when a partial/raw object is supplied
    return loadAndValidateConfig();
  }
  return loadAndValidateConfig();
}

export class ConfigValidator {
  private currentConfig: BettingConfig = {};

  setCurrentConfig(config: BettingConfig): void {
    this.currentConfig = { ...config };
  }

  getCurrentConfig(): BettingConfig {
    return { ...this.currentConfig };
  }

  validateBettingConfig(config: BettingConfig): ValidationResult {
    const errors: string[] = [];

    if (config.stake !== undefined) {
      if (config.stake <= 0) {
        errors.push('Stake must be positive');
      }
      if (config.stake < 100) {
        errors.push('Stake must be at least 100');
      }
      if (config.stake > 1000000) {
        errors.push('Stake exceeds maximum allowed');
      }
    }

    if (config.cashOutTarget !== undefined) {
      if (config.cashOutTarget < 1.01) {
        errors.push('Cash-out target must be at least 1.01');
      }
      if (config.cashOutTarget > 100) {
        errors.push('Cash-out target exceeds maximum allowed');
      }
    }

    if (config.maxDailyEntries !== undefined) {
      if (config.maxDailyEntries <= 0) {
        errors.push('Max daily entries must be positive');
      }
      if (config.maxDailyEntries > 1000) {
        errors.push('Max daily entries exceeds maximum allowed');
      }
    }

    if (config.maxDrawdownPercent !== undefined) {
      if (config.maxDrawdownPercent <= 0 || config.maxDrawdownPercent > 100) {
        errors.push('Max drawdown percent must be between 1 and 100');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
