export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  sumPredicted: number;
  sumActual: number;
}

export function emptyBins(n = 10): ReliabilityBin[] {
  return Array.from({ length: n }, (_, i) => ({
    lower: i / n,
    upper: (i + 1) / n,
    count: 0,
    sumPredicted: 0,
    sumActual: 0,
  }));
}

export function updateBin(bins: ReliabilityBin[], predicted: number, actual: 0 | 1): void {
  const p = Math.min(0.999, Math.max(0.001, predicted));
  const idx = Math.min(bins.length - 1, Math.floor(p * bins.length));
  bins[idx].count += 1;
  bins[idx].sumPredicted += p;
  bins[idx].sumActual += actual;
}

export function expectedCalibrationError(bins: ReliabilityBin[]): number {
  let total = 0;
  let ece = 0;
  for (const b of bins) {
    if (b.count === 0) continue;
    total += b.count;
    const conf = b.sumPredicted / b.count;
    const acc = b.sumActual / b.count;
    ece += b.count * Math.abs(conf - acc);
  }
  return total > 0 ? ece / total : 0;
}

export function brierScore(predicted: number, actual: 0 | 1): number {
  const d = predicted - actual;
  return d * d;
}

export function logLoss(predicted: number, actual: 0 | 1): number {
  const p = Math.min(0.999, Math.max(0.001, predicted));
  return actual === 1 ? -Math.log(p) : -Math.log(1 - p);
}
