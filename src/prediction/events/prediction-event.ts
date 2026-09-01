/**
 * Full PredictionGenerated contract (design §19).
 */

export interface PredictionGeneratedEvent {
  predictionId: string;
  roundId: string;
  tenantId: string | null;
  modelVersion: string;
  featureVersion: string;
  regimeVersion: string;
  calibrationVersion: string;
  target: number;
  rawProbability: number;
  calibratedProbability: number;
  confidence: number;
  expectedValue: number;
  featureHash: string;
  timestamp: string;
  latencyMs: number;
  action: 'ENTRY' | 'REDUCED_ENTRY' | 'SKIP';
  opportunityScore?: number;
  opportunityRank?: number;
  metaProbability?: number;
  agreement?: number;
  threshold?: number;
}

export function buildPredictionGeneratedEvent(
  partial: PredictionGeneratedEvent
): PredictionGeneratedEvent {
  return { ...partial };
}
