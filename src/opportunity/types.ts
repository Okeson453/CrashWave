/**
 * Opportunity scoring & ranking — quality over volume.
 * Design ref: Sections 5, 9, 10
 */

export interface OpportunityDimensions {
  /** Predicted edge / expected value component 0–1 */
  edge: number;
  /** Model confidence 0–1 */
  confidence: number;
  /** Data quality score 0–1 */
  dataQuality: number;
  /** Regime suitability 0–1 */
  regimeFit: number;
  /** Execution feasibility (latency, browser health) 0–1 */
  executionFeasibility: number;
  /** Temporal consistency with recent window 0–1 */
  temporalConsistency: number;
}

export interface ScoredOpportunity {
  id: string;
  roundId: string;
  tenantId: string | null;
  dimensions: OpportunityDimensions;
  /** Geometric mean of dimensions — prevents single-dimension dominance */
  qualityScore: number;
  probability: number;
  confidence: number;
  regime: string | null;
  modelVersion: string | null;
  scoredAt: string;
  expiresAt: string;
  rank?: number;
}

export type DecisionType =
  | 'ENTER'
  | 'WAIT'
  | 'REJECT'
  | 'MONITOR'
  | 'ESCALATE'
  | 'REDUCE_EXPOSURE'
  | 'SHEATH'
  | 'REQUEST_CONFIRMATION';

export interface DecisionRecord {
  id: string;
  opportunityId: string;
  roundId: string;
  decision: DecisionType;
  qualityScore: number;
  rank: number | null;
  thresholdUsed: number;
  reasons: string[];
  provenance: {
    predictionId?: string;
    modelVersions?: string[];
    regime?: string | null;
    sheathState?: string;
  };
  decidedAt: string;
}

/** Geometric mean — design decision §26.2 */
export function geometricMean(values: number[]): number {
  const clamped = values.map((v) => Math.max(1e-9, Math.min(1, v)));
  const logSum = clamped.reduce((acc, v) => acc + Math.log(v), 0);
  return Math.exp(logSum / clamped.length);
}

export function scoreOpportunity(dims: OpportunityDimensions): number {
  return geometricMean([
    dims.edge,
    dims.confidence,
    dims.dataQuality,
    dims.regimeFit,
    dims.executionFeasibility,
    dims.temporalConsistency,
  ]);
}
