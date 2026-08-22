import {
  fractionalKellyStake,
  paretoSurvival,
  consecutiveLossProbability,
  shouldTriggerVolatilityCooldown,
} from '../../../src/risk/provably-fair/kelly';

describe('fractionalKellyStake', () => {
  it('returns 0 when no edge', () => {
    expect(
      fractionalKellyStake({
        winProbability: 0.5,
        netOdds: 0.3,
        lambda: 0.25,
        bankroll: 10000,
      })
    ).toBe(0);
  });

  it('scales with lambda', () => {
    const full = fractionalKellyStake({
      winProbability: 0.8,
      netOdds: 0.3,
      lambda: 1,
      bankroll: 10000,
      maxFraction: 1,
    });
    const frac = fractionalKellyStake({
      winProbability: 0.8,
      netOdds: 0.3,
      lambda: 0.25,
      bankroll: 10000,
      maxFraction: 1,
    });
    expect(frac).toBeLessThan(full);
    expect(frac).toBeGreaterThan(0);
  });

  it('respects absoluteMaxStake', () => {
    const s = fractionalKellyStake({
      winProbability: 0.9,
      netOdds: 0.3,
      lambda: 1,
      bankroll: 100000,
      absoluteMaxStake: 700,
      maxFraction: 1,
    });
    expect(s).toBeLessThanOrEqual(700);
  });
});

describe('pareto / streak', () => {
  it('paretoSurvival decreases with target', () => {
    expect(paretoSurvival({ xm: 1, alpha: 1.5, target: 2 })).toBeLessThan(1);
    expect(paretoSurvival({ xm: 1, alpha: 1.5, target: 10 })).toBeLessThan(
      paretoSurvival({ xm: 1, alpha: 1.5, target: 2 })
    );
  });

  it('consecutive loss probability', () => {
    expect(consecutiveLossProbability(3, 0.5)).toBeCloseTo(0.125);
  });

  it('volatility cooldown triggers on long streak', () => {
    expect(
      shouldTriggerVolatilityCooldown({
        consecutiveLosses: 20,
        expectedLossProb: 0.5,
        sigmaThreshold: 3,
      })
    ).toBe(true);
    expect(
      shouldTriggerVolatilityCooldown({
        consecutiveLosses: 1,
        expectedLossProb: 0.5,
        sigmaThreshold: 3,
      })
    ).toBe(false);
  });
});
