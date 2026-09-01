/**
 * Phase 3.4 — Concrete contract for buildRiskInput callbacks.
 */

import type { RiskEvaluationInput } from './types.js';

export type RiskInputProvider = (
  hints?: Record<string, unknown>
) => RiskEvaluationInput | Promise<RiskEvaluationInput>;

export interface RiskInputProviderContext {
  /** Optional round id being evaluated */
  roundId?: string;
  /** Optional payload from worker event */
  payload?: Record<string, unknown>;
}

/** Validate required fields present for a minimal risk decision */
export function assertRiskInputShape(input: RiskEvaluationInput): void {
  const required: (keyof RiskEvaluationInput)[] = [
    'mode',
    'operatorAuthorized',
    'sessionAuthenticated',
    'gameLoaded',
    'killSwitch',
    'paused',
  ];
  for (const k of required) {
    if (input[k] === undefined) {
      throw new Error(`RiskEvaluationInput missing required field: ${String(k)}`);
    }
  }
}
