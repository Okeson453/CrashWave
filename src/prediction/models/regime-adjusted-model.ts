export function regimeAdjustedProbability(
  baseline: number,
  regime: string,
  improvement: number
): number {
  let p = baseline;
  if (regime === 'low-cluster' || regime === 'deep-low') {
    p = baseline + Math.max(0.02, improvement * 0.55);
  } else if (regime === 'volatile') {
    p = baseline * 0.97;
  } else if (regime === 'high-activity') {
    p = baseline + 0.025;
  }
  return Math.max(0.01, Math.min(0.99, p));
}
