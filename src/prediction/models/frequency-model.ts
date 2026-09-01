export function frequencyModelProbability(ewmaHitRate: number, fallback = 0.65): number {
  return ewmaHitRate > 0 ? Math.max(0.01, Math.min(0.99, ewmaHitRate)) : fallback;
}
