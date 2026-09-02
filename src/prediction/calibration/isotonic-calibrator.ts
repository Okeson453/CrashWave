/**
 * Isotonic regression calibrator (PAV algorithm).
 * Maps raw scores → calibrated probabilities with monotonicity constraint.
 */

interface Block {
  weight: number;
  sumY: number;
  minX: number;
  maxX: number;
}

export class IsotonicCalibrator {
  private blocks: Block[] = [];
  fitted = false;
  sampleCount = 0;

  fit(pairs: Array<{ p: number; y: 0 | 1 }>): void {
    if (pairs.length < 30) {
      this.fitted = false;
      this.blocks = [];
      return;
    }
    const sorted = [...pairs].sort((a, b) => a.p - b.p);
    const blocks: Block[] = sorted.map((r) => ({
      weight: 1,
      sumY: r.y,
      minX: r.p,
      maxX: r.p,
    }));

    // Pool Adjacent Violators
    let i = 0;
    while (i < blocks.length - 1) {
      const meanI = blocks[i].sumY / blocks[i].weight;
      const meanNext = blocks[i + 1].sumY / blocks[i + 1].weight;
      if (meanI > meanNext + 1e-12) {
        blocks[i] = {
          weight: blocks[i].weight + blocks[i + 1].weight,
          sumY: blocks[i].sumY + blocks[i + 1].sumY,
          minX: blocks[i].minX,
          maxX: blocks[i + 1].maxX,
        };
        blocks.splice(i + 1, 1);
        if (i > 0) i -= 1;
      } else {
        i += 1;
      }
    }
    this.blocks = blocks;
    this.fitted = blocks.length > 0;
    this.sampleCount = pairs.length;
  }

  calibrate(p: number): number {
    if (!this.fitted || this.blocks.length === 0) return p;
    // Find block by x range; interpolate by nearest mean
    for (const b of this.blocks) {
      if (p >= b.minX && p <= b.maxX) {
        return Math.min(0.99, Math.max(0.01, b.sumY / b.weight));
      }
    }
    if (p < this.blocks[0].minX) {
      return Math.min(0.99, Math.max(0.01, this.blocks[0].sumY / this.blocks[0].weight));
    }
    const last = this.blocks[this.blocks.length - 1];
    return Math.min(0.99, Math.max(0.01, last.sumY / last.weight));
  }
}
