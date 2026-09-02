export function modelDisagreement(probabilities: number[]): number {
  const n = probabilities.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += probabilities[i];
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = probabilities[i] - mean;
    varSum += d * d;
  }
  return Math.sqrt(varSum / n);
}

export function agreementScore(probabilities: number[]): number {
  return Math.max(0, 1 - modelDisagreement(probabilities) * 2);
}
