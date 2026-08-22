import { createHash } from 'crypto';
import { HistoricalRound, Label, TargetVersion, ThresholdTarget, SUPPORTED_TARGETS } from '../types.js';
export const CURRENT_TARGET_VERSION: TargetVersion = 'tv-1.0.0';
export class LabelGenerator {
  readonly targetVersion: TargetVersion;
  readonly thresholds: readonly ThresholdTarget[];
  constructor(thresholds: readonly ThresholdTarget[] = SUPPORTED_TARGETS, targetVersion: TargetVersion = CURRENT_TARGET_VERSION) {
    this.thresholds = thresholds;
    this.targetVersion = targetVersion;
  }
  generate(round: HistoricalRound): Label {
    const thresholds: Record<string, 0 | 1> = {};
    for (const t of this.thresholds) {
      thresholds[t.toFixed(2)] = round.crashPoint >= t ? 1 : 0;
    }
    return {
      roundId: round.id,
      targetVersion: this.targetVersion,
      thresholds,
      crashPoint: round.crashPoint,
      timestamp: round.crashedAt ?? round.createdAt,
    };
  }
  generateMany(rounds: HistoricalRound[]): Label[] {
    return rounds.map((r) => this.generate(r));
  }
  configHash(): string {
    return createHash('sha256').update(`${this.targetVersion}|${this.thresholds.join(',')}`).digest('hex').slice(0, 16);
  }
}
