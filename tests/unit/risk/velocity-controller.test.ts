import { VelocityController } from '../../../src/risk/velocity-controller';

describe('VelocityController', () => {
  it('allows when disabled', async () => {
    const v = new VelocityController({
      enabled: false,
      minActionIntervalMs: 8000,
      maxActionIntervalMs: 25000,
      maxActionsPerMinute: 4,
      maxActionsPerHour: 60,
      idleProbability: 0,
      minIdleMs: 30000,
      maxIdleMs: 180000,
      cashOutJitterMs: 180,
    });
    const d = await v.acquire('bet');
    expect(d.allowed).toBe(true);
  });

  it('enforces min interval after record', async () => {
    const v = new VelocityController({
      enabled: true,
      minActionIntervalMs: 5000,
      maxActionIntervalMs: 5000,
      maxActionsPerMinute: 10,
      maxActionsPerHour: 100,
      idleProbability: 0,
      minIdleMs: 1000,
      maxIdleMs: 2000,
      cashOutJitterMs: 0,
    });
    v.record('bet');
    const d = await v.acquire('bet');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('minInterval');
    expect(d.waitMs).toBeGreaterThan(0);
  });

  it('returns cash-out jitter in range', () => {
    const v = new VelocityController({
      enabled: true,
      minActionIntervalMs: 1000,
      maxActionIntervalMs: 2000,
      maxActionsPerMinute: 4,
      maxActionsPerHour: 60,
      idleProbability: 0,
      minIdleMs: 1000,
      maxIdleMs: 2000,
      cashOutJitterMs: 100,
    });
    const j = v.getCashOutJitter();
    expect(j).toBeGreaterThanOrEqual(0);
    expect(j).toBeLessThanOrEqual(100);
  });
});
