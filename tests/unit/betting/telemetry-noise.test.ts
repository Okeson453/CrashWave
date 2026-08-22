import { TelemetryNoise } from '../../../src/betting/telemetry-noise';

describe('TelemetryNoise', () => {
  it('passes through target when disabled', () => {
    const n = new TelemetryNoise({
      enabled: false,
      cashOutTargetNoise: 0.05,
      skipEntryProbability: 0.5,
      delayedCashOutProbability: 0.5,
    });
    expect(n.applyCashOutNoise(1.3)).toBe(1.3);
    expect(n.shouldSkipEntry()).toBe(false);
  });

  it('applies noise within band when enabled', () => {
    const n = new TelemetryNoise({
      enabled: true,
      cashOutTargetNoise: 0.02,
      skipEntryProbability: 0,
      delayedCashOutProbability: 0,
    });
    for (let i = 0; i < 20; i++) {
      const t = n.applyCashOutNoise(1.3);
      expect(t).toBeGreaterThanOrEqual(1.01);
      expect(t).toBeLessThanOrEqual(1.3 * 1.02 + 0.001);
    }
  });
});
