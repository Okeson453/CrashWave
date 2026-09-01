export function conditionalFrequencyProbability(
  conditional: number,
  baseline: number,
  matchCount: number,
  minMatches = 40
): number {
  const p = matchCount >= minMatches ? conditional : baseline;
  return Math.max(0.01, Math.min(0.99, p));
}
