import { randomUUID } from 'crypto';
import { computeOpportunityScore, type OpportunityInputs } from './opportunity-score.js';

export interface OpportunityRecord {
  opportunityId: string;
  predictionId: string;
  target: number;
  probability: number;
  calibratedProbability: number;
  expectedValue: number;
  confidence: number;
  score: number;
  rank: number;
  regime: string;
  modelVersion: string;
  featureVersion: string;
  timestamp: string;
  expiry: string;
}

export class OpportunityRanker {
  private readonly window: OpportunityRecord[] = [];
  private readonly maxWindow: number;

  constructor(maxWindow = 500) {
    this.maxWindow = maxWindow;
  }

  scoreAndInsert(params: {
    predictionId: string;
    target: number;
    probability: number;
    calibratedProbability: number;
    expectedValue: number;
    confidence: number;
    regime: string;
    modelVersion: string;
    featureVersion: string;
    inputs: OpportunityInputs;
    ttlMs?: number;
  }): OpportunityRecord {
    const score = computeOpportunityScore(params.inputs);
    const now = Date.now();
    const rec: OpportunityRecord = {
      opportunityId: randomUUID(),
      predictionId: params.predictionId,
      target: params.target,
      probability: params.probability,
      calibratedProbability: params.calibratedProbability,
      expectedValue: params.expectedValue,
      confidence: params.confidence,
      score,
      rank: 0,
      regime: params.regime,
      modelVersion: params.modelVersion,
      featureVersion: params.featureVersion,
      timestamp: new Date(now).toISOString(),
      expiry: new Date(now + (params.ttlMs ?? 45_000)).toISOString(),
    };
    this.window.push(rec);
    if (this.window.length > this.maxWindow) {
      this.window.splice(0, this.window.length - this.maxWindow);
    }
    this.rerank();
    return rec;
  }

  private rerank(): void {
    const sorted = [...this.window].sort((a, b) => b.score - a.score);
    const rankMap = new Map<string, number>();
    sorted.forEach((r, i) => rankMap.set(r.opportunityId, i + 1));
    for (const r of this.window) {
      r.rank = rankMap.get(r.opportunityId) ?? 0;
    }
  }

  top(n = 10): OpportunityRecord[] {
    return [...this.window].sort((a, b) => a.rank - b.rank).slice(0, n);
  }

  getWindow(): readonly OpportunityRecord[] {
    return this.window;
  }

  clear(): void {
    this.window.length = 0;
  }
}

export const globalOpportunityRanker = new OpportunityRanker();
