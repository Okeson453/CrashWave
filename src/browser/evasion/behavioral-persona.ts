/**
 * Behavioral Persona Engine — seed-stable human simulation via archetype + intensity curve.
 * Drives bet timing, skips, stake/target jitter, idle actions, session breaks.
 */

import { getLogger } from '../../observability/logger.js';

export type PersonaArchetype =
  | 'aggressive'
  | 'cautious'
  | 'sporadic'
  | 'methodical'
  | 'social'
  | 'night-owl';

export interface PersonaConfig {
  seed: number;
  archetype?: PersonaArchetype;
  screenWidth: number;
  screenHeight: number;
}

export interface BetTiming {
  preBetDelayMs: number;
  cashOutDelayMs: number;
  skipProbability: number;
  stakeMultiplier: number;
  targetMultiplier: number;
  useAutoCashOut: boolean;
  /** True when this round should be skipped entirely */
  skip: boolean;
}

export interface IdleAction {
  type: 'hover' | 'scroll' | 'click-ui' | 'chat-focus' | 'history-scroll' | 'rest';
  durationMs: number;
  targetX?: number;
  targetY?: number;
}

export interface SessionRhythm {
  targetDurationMin: number;
  breakProbability: number;
  breakDurationMs: [number, number];
  intensityCurve: 'flat' | 'escalating' | 'de-escalating' | 'wave';
}

interface PersonaState {
  roundsPlayed: number;
  totalSessionMs: number;
  currentIntensity: number;
  lastBetAt: number;
  consecutiveSkips: number;
  consecutiveBets: number;
  sessionStartedAt: number;
}

interface ArchetypeParams {
  baseSkipProb: number;
  preBetMeanMs: number;
  preBetTauMs: number;
  reactionMeanMs: number;
  reactionTauMs: number;
  stakeSigma: number;
  targetSigma: number;
  autoCashOutProb: number;
  idleWeights: Record<IdleAction['type'], number>;
}

class SeededRNG {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    this.state = t >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gaussian(mean = 0, sd = 1): number {
    const u = Math.max(1e-9, this.next());
    const v = Math.max(1e-9, this.next());
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + z * sd;
  }
}

const ARCHETYPES: PersonaArchetype[] = [
  'aggressive',
  'cautious',
  'sporadic',
  'methodical',
  'social',
  'night-owl',
];

export class BehavioralPersona {
  private readonly logger = getLogger();
  private readonly seed: number;
  private readonly archetype: PersonaArchetype;
  private readonly screenWidth: number;
  private readonly screenHeight: number;
  private readonly rhythm: SessionRhythm;
  private state: PersonaState;
  private readonly rng: SeededRNG;

  constructor(config: PersonaConfig) {
    this.seed = config.seed;
    this.rng = new SeededRNG(this.seed);
    this.archetype = config.archetype ?? this.deriveArchetype();
    this.screenWidth = config.screenWidth;
    this.screenHeight = config.screenHeight;
    this.rhythm = this.buildRhythm();
    this.state = this.initialState();
    this.logger.info(
      { component: 'BehavioralPersona', archetype: this.archetype, seed: this.seed },
      'Persona initialized'
    );
  }

  getArchetype(): PersonaArchetype {
    return this.archetype;
  }

  getState(): Readonly<PersonaState> {
    return { ...this.state };
  }

  generateBetTiming(baseStake: number, baseTarget: number): BetTiming {
    void baseStake;
    const intensity = this.computeIntensity();
    const p = this.getArchetypeParams();

    let skipProb = p.baseSkipProb;
    if (this.state.consecutiveBets > 5) skipProb += 0.08;
    if (this.state.consecutiveBets > 10) skipProb += 0.15;
    if (this.state.consecutiveSkips > 2) skipProb -= 0.1;

    if (this.archetype === 'night-owl') {
      const progress =
        this.state.totalSessionMs / Math.max(1, this.rhythm.targetDurationMin * 60000);
      skipProb *= 1 - Math.min(0.3, progress * 0.3);
    }
    skipProb = Math.max(0, Math.min(0.4, skipProb));

    if (this.rng.next() < skipProb) {
      this.state.consecutiveSkips++;
      this.state.consecutiveBets = 0;
      this.state.roundsPlayed++;
      return {
        preBetDelayMs: 0,
        cashOutDelayMs: 0,
        skipProbability: 1,
        stakeMultiplier: 0,
        targetMultiplier: 0,
        useAutoCashOut: false,
        skip: true,
      };
    }

    const preBetMean = p.preBetMeanMs * (1 + (1 - intensity) * 0.3);
    const preBetDelayMs = this.exGaussian(preBetMean, 40, p.preBetTauMs);
    const reactionMean = p.reactionMeanMs * (1 + (intensity - 0.5) * 0.4);
    const cashOutDelayMs = Math.max(50, this.exGaussian(reactionMean, 25, p.reactionTauMs));
    const stakeMultiplier = Math.exp(this.rng.gaussian(0, p.stakeSigma));
    const targetMultiplier = Math.max(1.01, baseTarget + this.rng.gaussian(0, p.targetSigma));
    const useAutoCashOut = this.rng.next() < p.autoCashOutProb;

    this.state.consecutiveBets++;
    this.state.consecutiveSkips = 0;
    this.state.lastBetAt = Date.now();
    this.state.roundsPlayed++;
    this.state.totalSessionMs = Date.now() - this.state.sessionStartedAt;

    return {
      preBetDelayMs: Math.round(preBetDelayMs),
      cashOutDelayMs: Math.round(cashOutDelayMs),
      skipProbability: 0,
      stakeMultiplier: Math.round(stakeMultiplier * 100) / 100,
      targetMultiplier: Math.round(targetMultiplier * 100) / 100,
      useAutoCashOut,
      skip: false,
    };
  }

  generateIdleActions(): IdleAction[] {
    const p = this.getArchetypeParams();
    const actions: IdleAction[] = [];
    const numActions = Math.floor(this.rng.next() * 3) + 1;
    for (let i = 0; i < numActions; i++) {
      const type = this.weightedPick(p.idleWeights);
      const durationMs = Math.round(this.rng.next() * 2000 + 500);
      let targetX: number | undefined;
      let targetY: number | undefined;
      if (type === 'hover' || type === 'click-ui') {
        targetX = this.rng.next() * this.screenWidth;
        targetY = this.rng.next() * this.screenHeight;
      } else if (type === 'chat-focus') {
        targetX = this.screenWidth * 0.85;
        targetY = this.screenHeight * 0.6;
      } else if (type === 'history-scroll') {
        targetX = this.screenWidth * 0.5;
        targetY = this.screenHeight * 0.3;
      }
      actions.push({ type, durationMs, targetX, targetY });
    }
    return actions;
  }

  shouldTakeBreak(): { shouldBreak: boolean; durationMs: number } {
    if (this.rng.next() > this.rhythm.breakProbability) {
      return { shouldBreak: false, durationMs: 0 };
    }
    const [minMs, maxMs] = this.rhythm.breakDurationMs;
    return {
      shouldBreak: true,
      durationMs: Math.round(minMs + this.rng.next() * (maxMs - minMs)),
    };
  }

  private deriveArchetype(): PersonaArchetype {
    return ARCHETYPES[this.seed % ARCHETYPES.length];
  }

  private buildRhythm(): SessionRhythm {
    const curves: SessionRhythm['intensityCurve'][] = [
      'flat',
      'escalating',
      'de-escalating',
      'wave',
    ];
    const curve = curves[this.seed % curves.length];
    const base: Record<PersonaArchetype, Partial<SessionRhythm>> = {
      aggressive: { targetDurationMin: 90, breakProbability: 0.04 },
      cautious: { targetDurationMin: 45, breakProbability: 0.12 },
      sporadic: { targetDurationMin: 60, breakProbability: 0.18 },
      methodical: { targetDurationMin: 75, breakProbability: 0.06 },
      social: { targetDurationMin: 80, breakProbability: 0.1 },
      'night-owl': { targetDurationMin: 120, breakProbability: 0.05 },
    };
    return {
      targetDurationMin: base[this.archetype].targetDurationMin ?? 60,
      breakProbability: base[this.archetype].breakProbability ?? 0.08,
      breakDurationMs: [30_000, 180_000],
      intensityCurve: curve,
    };
  }

  private initialState(): PersonaState {
    return {
      roundsPlayed: 0,
      totalSessionMs: 0,
      currentIntensity: 0.5,
      lastBetAt: 0,
      consecutiveSkips: 0,
      consecutiveBets: 0,
      sessionStartedAt: Date.now(),
    };
  }

  private computeIntensity(): number {
    const progress =
      this.state.totalSessionMs / Math.max(1, this.rhythm.targetDurationMin * 60000);
    let intensity = 0.5;
    switch (this.rhythm.intensityCurve) {
      case 'escalating':
        intensity = 0.35 + 0.55 * Math.min(1, progress);
        break;
      case 'de-escalating':
        intensity = 0.9 - 0.5 * Math.min(1, progress);
        break;
      case 'wave':
        intensity = 0.5 + 0.35 * Math.sin(progress * Math.PI * 2);
        break;
      default:
        intensity = 0.5;
    }
    this.state.currentIntensity = Math.max(0.15, Math.min(0.95, intensity));
    return this.state.currentIntensity;
  }

  private getArchetypeParams(): ArchetypeParams {
    const table: Record<PersonaArchetype, ArchetypeParams> = {
      aggressive: {
        baseSkipProb: 0.03,
        preBetMeanMs: 140,
        preBetTauMs: 60,
        reactionMeanMs: 180,
        reactionTauMs: 50,
        stakeSigma: 0.04,
        targetSigma: 0.02,
        autoCashOutProb: 0.7,
        idleWeights: { hover: 2, scroll: 1, rest: 1, 'click-ui': 1, 'chat-focus': 0.5, 'history-scroll': 1 },
      },
      cautious: {
        baseSkipProb: 0.12,
        preBetMeanMs: 320,
        preBetTauMs: 120,
        reactionMeanMs: 350,
        reactionTauMs: 100,
        stakeSigma: 0.02,
        targetSigma: 0.01,
        autoCashOutProb: 0.9,
        idleWeights: { hover: 2, scroll: 2, rest: 3, 'click-ui': 0.5, 'chat-focus': 0.5, 'history-scroll': 2 },
      },
      sporadic: {
        baseSkipProb: 0.18,
        preBetMeanMs: 250,
        preBetTauMs: 200,
        reactionMeanMs: 280,
        reactionTauMs: 150,
        stakeSigma: 0.08,
        targetSigma: 0.04,
        autoCashOutProb: 0.4,
        idleWeights: { hover: 1, scroll: 1, rest: 3, 'click-ui': 1, 'chat-focus': 1, 'history-scroll': 1 },
      },
      methodical: {
        baseSkipProb: 0.05,
        preBetMeanMs: 200,
        preBetTauMs: 40,
        reactionMeanMs: 250,
        reactionTauMs: 40,
        stakeSigma: 0.015,
        targetSigma: 0.008,
        autoCashOutProb: 0.85,
        idleWeights: { hover: 2, scroll: 1, rest: 2, 'click-ui': 0.5, 'chat-focus': 0.3, 'history-scroll': 2 },
      },
      social: {
        baseSkipProb: 0.1,
        preBetMeanMs: 280,
        preBetTauMs: 100,
        reactionMeanMs: 300,
        reactionTauMs: 90,
        stakeSigma: 0.03,
        targetSigma: 0.02,
        autoCashOutProb: 0.6,
        idleWeights: { hover: 1, scroll: 1, rest: 1, 'click-ui': 1, 'chat-focus': 4, 'history-scroll': 1 },
      },
      'night-owl': {
        baseSkipProb: 0.06,
        preBetMeanMs: 180,
        preBetTauMs: 80,
        reactionMeanMs: 220,
        reactionTauMs: 70,
        stakeSigma: 0.05,
        targetSigma: 0.03,
        autoCashOutProb: 0.55,
        idleWeights: { hover: 2, scroll: 1, rest: 2, 'click-ui': 1, 'chat-focus': 1, 'history-scroll': 1 },
      },
    };
    return table[this.archetype];
  }

  private exGaussian(mean: number, sd: number, tau: number): number {
    const u = Math.max(1e-9, this.rng.next());
    const v = Math.max(1e-9, this.rng.next());
    const gauss = mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const exp = -tau * Math.log(Math.max(1e-9, this.rng.next()));
    return Math.max(0, gauss + exp);
  }

  private weightedPick(weights: Record<IdleAction['type'], number>): IdleAction['type'] {
    const entries = Object.entries(weights) as Array<[IdleAction['type'], number]>;
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.rng.next() * total;
    for (const [k, w] of entries) {
      r -= w;
      if (r <= 0) return k;
    }
    return entries[0][0];
  }
}

/** Derive numeric seed from profile id string */
export function seedFromProfileId(profileId: string): number {
  let h = 2166136261;
  for (let i = 0; i < profileId.length; i++) {
    h ^= profileId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
