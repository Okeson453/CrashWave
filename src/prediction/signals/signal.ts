import { PredictionOutput, PredictionSignal } from '../types.js';

export function toSignal(output: PredictionOutput): PredictionSignal {
  return Object.freeze({
    predictionId: output.predictionId,
    timestamp: output.timestamp,
    modelVersion: `${output.model.name}@${output.model.version}`,
    featureVersion: output.model.featureVersion,
    target: output.target,
    score: output.score,
    probability: output.probability,
    confidence: output.confidence,
    regimeId: output.regime?.id ?? null,
    dataQuality: output.dataQuality,
    reasoning: Object.freeze([...output.reasoning]),
    expiresAt: output.expiresAt,
    featureSummary: Object.freeze({ ...output.featureSummary }),
  });
}
export function isSignalExpired(signal: PredictionSignal, now = new Date()): boolean {
  return new Date(signal.expiresAt).getTime() <= now.getTime();
}
export function isSignalFresh(signal: PredictionSignal, maxAgeMs = 30_000, now = new Date()): boolean {
  if (isSignalExpired(signal, now)) return false;
  return now.getTime() - new Date(signal.timestamp).getTime() <= maxAgeMs;
}
