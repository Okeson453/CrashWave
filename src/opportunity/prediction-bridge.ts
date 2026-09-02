
/**
 * Unifies prediction-layer opportunity scores with the decision OpportunityRanker.
 */

import type { OpportunityRanker } from "./ranker.js";
import type { ScoredOpportunity } from "./types.js";
import type { OpportunityRecord } from "../prediction/opportunity/opportunity-ranker.js";

export function predictionRecordToScored(
  rec: OpportunityRecord,
  dims?: Partial<ScoredOpportunity["dimensions"]>
): ScoredOpportunity {
  const conf = rec.confidence;
  const quality = Math.max(0, Math.min(1, 0.5 + rec.score * 2)); // map EV-ish score to 0–1
  return {
    id: rec.opportunityId,
    roundId: rec.predictionId,
    tenantId: null,
    dimensions: {
      edge: Math.max(0, Math.min(1, 0.5 + rec.expectedValue)),
      confidence: conf,
      dataQuality: 0.9,
      regimeFit: 0.7,
      executionFeasibility: 0.9,
      temporalConsistency: 0.8,
      ...dims,
    },
    qualityScore: quality,
    probability: rec.calibratedProbability,
    confidence: conf,
    regime: rec.regime,
    modelVersion: rec.modelVersion,
    scoredAt: rec.timestamp,
    expiresAt: rec.expiry,
    rank: rec.rank,
  };
}

/** Push pipeline opportunity into decision ranker window */
export function bridgeOpportunityToDecisionRanker(
  ranker: OpportunityRanker,
  rec: OpportunityRecord
): ScoredOpportunity | null {
  return ranker.upsert(predictionRecordToScored(rec));
}
