/**
 * Behavioral Entropy Engine — non-deterministic human-like timing & decision noise.
 * Used for bet placement delay, cash-out reaction, missed rounds, stake micro-variation.
 */

export interface BehavioralEntropyConfig {
  /** Mean delay before placing bet after opportunity (ms) */
  betDelayMeanMs: number;
  betDelaySdMs: number;
  /** Ex-Gaussian cash-out reaction: mean, sd, tau */
  cashoutMeanMs: number;
  cashoutSdMs: number;
  cashoutTauMs: number;
  /** Probability of intentionally skipping an opportunity (0–1) */
  missRoundProbability: number;
  /** Stake micro-variation fraction (e.g. 0.03 = ±3%) */
  stakeJitterFraction: number;
  /** Hesitation pause before click (ms range) */
  hesitationMinMs: number;
  hesitationMaxMs: number;
  /** Seed for session-stable personality (optional) */
  seed?: string;
}

export const DEFAULT_ENTROPY: BehavioralEntropyConfig = {
  betDelayMeanMs: 200,
  betDelaySdMs: 150,
  cashoutMeanMs: 280,
  cashoutSdMs: 80,
  cashoutTauMs: 100,
  missRoundProbability: 0.07,
  stakeJitterFraction: 0.03,
  hesitationMinMs: 50,
  hesitationMaxMs: 300,
};

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function normal(rand: () => number, mean: number, sd: number): number {
  // Box-Muller
  const u = Math.max(1e-9, rand());
  const v = Math.max(1e-9, rand());
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * sd;
}

function logNormal(rand: () => number, mean: number, sd: number): number {
  // Approximate log-normal with mean≈mean for positive delays
  const mu = Math.log(Math.max(1, mean)) - 0.5 * Math.log(1 + (sd / Math.max(1, mean)) ** 2);
  const sigma = Math.sqrt(Math.log(1 + (sd / Math.max(1, mean)) ** 2));
  return Math.exp(normal(rand, mu, sigma));
}

/** Ex-Gaussian = normal + exponential (human reaction times) */
function exGaussian(
  rand: () => number,
  mean: number,
  sd: number,
  tau: number
): number {
  const gauss = normal(rand, mean, sd);
  const exp = -tau * Math.log(Math.max(1e-9, rand()));
  return Math.max(0, gauss + exp);
}

export class BehavioralEntropyEngine {
  private readonly cfg: BehavioralEntropyConfig;
  private readonly rand: () => number;

  constructor(cfg: Partial<BehavioralEntropyConfig> = {}) {
    this.cfg = { ...DEFAULT_ENTROPY, ...cfg };
    const seedNum = this.cfg.seed ? hashSeed(this.cfg.seed) : (Date.now() >>> 0);
    this.rand = mulberry32(seedNum ^ 0xbe7);
  }

  /** Delay before acting on a bet opportunity (log-normal). */
  sampleBetDelayMs(): number {
    const v = logNormal(this.rand, this.cfg.betDelayMeanMs, this.cfg.betDelaySdMs);
    return Math.max(30, Math.min(2500, Math.round(v)));
  }

  /** Cash-out reaction time (ex-Gaussian). */
  sampleCashoutReactionMs(): number {
    const v = exGaussian(
      this.rand,
      this.cfg.cashoutMeanMs,
      this.cfg.cashoutSdMs,
      this.cfg.cashoutTauMs
    );
    return Math.max(40, Math.min(2000, Math.round(v)));
  }

  /** Hesitation before click near bet UI. */
  sampleHesitationMs(): number {
    const a = this.cfg.hesitationMinMs;
    const b = this.cfg.hesitationMaxMs;
    return Math.round(a + this.rand() * (b - a));
  }

  /** Humans miss rounds; bots rarely do. */
  shouldMissRound(): boolean {
    return this.rand() < this.cfg.missRoundProbability;
  }

  /**
   * Micro-vary stake. Returns integer stake when base is integer-like.
   * Clamped so variation stays within fraction.
   */
  jitterStake(baseStake: number): number {
    const f = this.cfg.stakeJitterFraction;
    if (f <= 0 || baseStake <= 0) return baseStake;
    const delta = (this.rand() * 2 - 1) * f;
    const next = baseStake * (1 + delta);
    if (Number.isInteger(baseStake)) return Math.max(1, Math.round(next));
    return Math.max(0.01, Math.round(next * 100) / 100);
  }

  async waitBetDelay(): Promise<number> {
    const ms = this.sampleBetDelayMs();
    await sleep(ms);
    return ms;
  }

  async waitCashoutReaction(): Promise<number> {
    const ms = this.sampleCashoutReactionMs();
    await sleep(ms);
    return ms;
  }

  async waitHesitation(): Promise<number> {
    const ms = this.sampleHesitationMs();
    await sleep(ms);
    return ms;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
