import { computeTriggerMultiplier, RttEstimator } from '../../../src/network/tls/native-socket';

describe('computeTriggerMultiplier', () => {
  it('subtracts latency compensation', () => {
    const t = computeTriggerMultiplier({
      currentMultiplier: 1.2,
      multiplierVelocity: 0.5, // per second
      targetMultiplier: 1.3,
      rttP99Ms: 100,
      safetyMarginMs: 0,
    });
    // lead 0.1s * 0.5 = 0.05 → trigger 1.25
    expect(t).toBeCloseTo(1.25, 2);
  });

  it('never goes below 1.01', () => {
    const t = computeTriggerMultiplier({
      currentMultiplier: 1.0,
      multiplierVelocity: 10,
      targetMultiplier: 1.05,
      rttP99Ms: 500,
      safetyMarginMs: 100,
    });
    expect(t).toBe(1.01);
  });
});

describe('RttEstimator', () => {
  it('returns conservative default when empty', () => {
    expect(new RttEstimator().p99()).toBe(80);
  });

  it('computes p99 from samples', () => {
    const e = new RttEstimator(100);
    for (let i = 1; i <= 100; i++) e.record(i);
    expect(e.p99()).toBeGreaterThanOrEqual(99);
  });
});
