/**
 * Platt scaling: P = 1 / (1 + exp(A * logit(p) + B))
 * Fit with L2 regularization + held-out early selection.
 */

function logit(p: number): number {
  const q = Math.min(0.999, Math.max(0.001, p));
  return Math.log(q / (1 - q));
}

function sigmoid(z: number): number {
  if (z > 30) return 1;
  if (z < -30) return 0;
  return 1 / (1 + Math.exp(-z));
}

function logLoss(pairs: Array<{ p: number; y: 0 | 1 }>, A: number, B: number): number {
  let s = 0;
  for (const { p, y } of pairs) {
    const pred = Math.min(0.999, Math.max(0.001, sigmoid(A * logit(p) + B)));
    s += y === 1 ? -Math.log(pred) : -Math.log(1 - pred);
  }
  return pairs.length ? s / pairs.length : 0;
}

export class PlattCalibrator {
  A = 0;
  B = 0;
  fitted = false;
  sampleCount = 0;
  heldOutLogLoss = 0;

  fit(
    pairs: Array<{ p: number; y: 0 | 1 }>,
    iterations = 80,
    lr = 0.05,
    l2 = 0.01,
    heldOutFraction = 0.2
  ): void {
    if (pairs.length < 20) {
      this.fitted = false;
      return;
    }
    const split = Math.max(10, Math.floor(pairs.length * (1 - heldOutFraction)));
    const train = pairs.slice(0, split);
    const held = pairs.slice(split);
    let A = 0;
    let B = 0;
    let bestA = 0;
    let bestB = 0;
    let bestHeld = Infinity;
    for (let iter = 0; iter < iterations; iter++) {
      let gA = 0;
      let gB = 0;
      for (const { p, y } of train) {
        const z = A * logit(p) + B;
        const pred = sigmoid(z);
        const err = pred - y;
        gA += err * logit(p);
        gB += err;
      }
      // L2 regularization
      gA += l2 * A * train.length;
      gB += l2 * B * train.length;
      A -= (lr * gA) / train.length;
      B -= (lr * gB) / train.length;
      const heldLl = held.length ? logLoss(held, A, B) : logLoss(train, A, B);
      if (heldLl < bestHeld) {
        bestHeld = heldLl;
        bestA = A;
        bestB = B;
      }
    }
    this.A = bestA;
    this.B = bestB;
    this.heldOutLogLoss = bestHeld;
    this.fitted = true;
    this.sampleCount = pairs.length;
  }

  calibrate(p: number): number {
    if (!this.fitted) return p;
    return sigmoid(this.A * logit(p) + this.B);
  }
}
