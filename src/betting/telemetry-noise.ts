/**
 * Telemetry noise / strategy obfuscation — optional pattern disruption.
 */

import { TelemetryNoiseConfig } from '../config/schema';
import { getLogger } from '../observability/logger';
import { metricCollector } from '../observability/metrics/collectors';

export class TelemetryNoise {
  private readonly logger = getLogger();

  constructor(private readonly config: TelemetryNoiseConfig) {}

  applyCashOutNoise(baseTarget: number): number {
    if (!this.config.enabled || this.config.cashOutTargetNoise <= 0) {
      return baseTarget;
    }
    const noise = (Math.random() * 2 - 1) * this.config.cashOutTargetNoise;
    const adjusted = Math.max(1.01, baseTarget * (1 + noise));
    this.logger.debug(
      { component: 'TelemetryNoise', baseTarget, adjusted },
      'Cash-out target noise applied'
    );
    (metricCollector as any).recordTelemetryNoiseApplied?.('cashOutTarget');
    return Number(adjusted.toFixed(4));
  }

  shouldSkipEntry(): boolean {
    if (!this.config.enabled) return false;
    const skip = Math.random() < this.config.skipEntryProbability;
    if (skip) (metricCollector as any).recordTelemetryNoiseApplied?.('skipEntry');
    return skip;
  }

  shouldDelayCashOut(): boolean {
    if (!this.config.enabled) return false;
    const delay = Math.random() < this.config.delayedCashOutProbability;
    if (delay) (metricCollector as any).recordTelemetryNoiseApplied?.('delayedCashOut');
    return delay;
  }
}
