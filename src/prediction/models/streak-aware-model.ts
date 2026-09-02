export function streakAwareProbability(
  baseline: number,
  streakHitRate: number | null
): number {
  if (streakHitRate == null) return Math.max(0.01, Math.min(0.99, baseline));
  return Math.max(0.01, Math.min(0.99, streakHitRate));
}
