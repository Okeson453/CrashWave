/**
 * Honest process readiness — prediction warm state for live / /ready.
 */

export type ReadinessState = {
  predictionWarm: boolean;
  historyRounds: number;
  acieHistorySize: number;
  calibrationWarm: boolean;
  prewarmCompleted: boolean;
  prewarmError: string | null;
  lastPrewarmAt: string | null;
  modelScope: 'global' | 'per-tenant';
};

let state: ReadinessState = {
  predictionWarm: false,
  historyRounds: 0,
  acieHistorySize: 0,
  calibrationWarm: false,
  prewarmCompleted: false,
  prewarmError: null,
  lastPrewarmAt: null,
  modelScope: 'global',
};

export type PrewarmLike = {
  stateWarm?: boolean;
  calibrationWarm?: boolean;
  historyRounds?: number;
  acieHistorySize?: number;
};

export function setPrewarmResult(r: PrewarmLike | null, err?: string): void {
  if (err || !r) {
    state = {
      ...state,
      prewarmCompleted: false,
      predictionWarm: false,
      prewarmError: err ?? 'prewarm failed',
      lastPrewarmAt: new Date().toISOString(),
    };
    return;
  }
  state = {
    ...state,
    predictionWarm: Boolean(r.stateWarm),
    calibrationWarm: Boolean(r.calibrationWarm),
    historyRounds: Number(r.historyRounds ?? 0),
    acieHistorySize: Number(r.acieHistorySize ?? 0),
    prewarmCompleted: true,
    prewarmError: null,
    lastPrewarmAt: new Date().toISOString(),
  };
}

export function isReadyForLive(opts?: { minHistory?: number; minAcie?: number }): boolean {
  const minHistory = opts?.minHistory ?? 50;
  const minAcie = opts?.minAcie ?? 20;
  return (
    state.prewarmCompleted &&
    state.predictionWarm &&
    state.historyRounds >= minHistory &&
    state.acieHistorySize >= minAcie &&
    !state.prewarmError
  );
}

export function getReadiness(): ReadinessState {
  return { ...state };
}

export function setModelScope(scope: 'global' | 'per-tenant'): void {
  state.modelScope = scope;
}
