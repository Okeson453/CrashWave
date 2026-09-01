/**
 * Immutable prediction-state publication point.
 * Real-time inference reads one coherent version; learning publishes a new version atomically.
 */
export interface PredictionStateSnapshot {
  version: number;
  featureVersion: string;
  modelVersion: string;
  regimeVersion: number;
  calibrationVersion: number;
  publishedAt: string;
}

export class PredictionStateRegistry {
  private current: PredictionStateSnapshot = {
    version: 1,
    featureVersion: 'acie-online-1',
    modelVersion: 'acie-v3',
    regimeVersion: 1,
    calibrationVersion: 1,
    publishedAt: new Date().toISOString(),
  };

  snapshot(): PredictionStateSnapshot {
    return { ...this.current };
  }

  publish(update: Partial<Omit<PredictionStateSnapshot, 'version' | 'publishedAt'>>): PredictionStateSnapshot {
    this.current = Object.freeze({
      ...this.current,
      ...update,
      version: this.current.version + 1,
      publishedAt: new Date().toISOString(),
    });
    return this.snapshot();
  }
}
