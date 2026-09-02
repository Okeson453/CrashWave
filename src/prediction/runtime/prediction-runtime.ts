/**
 * Scoped prediction runtime (platform or per-tenant).
 * Prefer injection over module-level globals on live paths.
 */

import { ACIEEngine } from '../acie/engine.js';
import { CalibrationState } from '../calibration/calibration-state.js';
import { LiveDivergenceMonitor } from '../validation/live-divergence-monitor.js';
import { EnsembleOrchestrator } from '../ensemble/ensemble-orchestrator.js';

export type RuntimeScopeId = string; // 'platform' | tenant UUID

export class PredictionRuntime {
  readonly scopeId: RuntimeScopeId;
  readonly acie: ACIEEngine;
  readonly calibration: CalibrationState;
  readonly divergence: LiveDivergenceMonitor;
  readonly ensemble: EnsembleOrchestrator;

  constructor(scopeId: RuntimeScopeId = 'platform') {
    this.scopeId = scopeId;
    this.acie = new ACIEEngine();
    this.calibration = new CalibrationState();
    this.divergence = new LiveDivergenceMonitor();
    this.ensemble = new EnsembleOrchestrator();
  }
}

const runtimes = new Map<RuntimeScopeId, PredictionRuntime>();

export function getPredictionRuntime(scopeId: RuntimeScopeId = 'platform'): PredictionRuntime {
  let rt = runtimes.get(scopeId);
  if (!rt) {
    rt = new PredictionRuntime(scopeId);
    runtimes.set(scopeId, rt);
  }
  return rt;
}

export function snapshotKeyForScope(scopeId: RuntimeScopeId): string {
  return `crash:prediction:stack:v2:${scopeId}`;
}

export function listRuntimeScopes(): RuntimeScopeId[] {
  return [...runtimes.keys()];
}
