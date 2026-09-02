/**
 * P0-12: Immutable prediction artifact schema for lineage.
 */
export interface PredictionArtifact {
  predictionId: string;
  roundId: string;
  modelVersion: string;
  featureVersion: string;
  calibrationVersion: string;
  thresholdVersion: string;
  regime: string;
  rawProbability: number;
  calibratedProbability: number;
  confidence: number;
  uncertainty: number;
  opportunityScore: number;
  threshold: number;
  decision: 'ENTER' | 'SKIP';
  generatedAt: string;
  expiresAt: string;
  featureHash: string;
  modelConfigHash: string;
}

export function isPredictionArtifact(v: unknown): v is PredictionArtifact {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as PredictionArtifact).predictionId === 'string' &&
    typeof (v as PredictionArtifact).roundId === 'string'
  );
}
