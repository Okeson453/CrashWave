/**
 * Single decision point for which bet execution path is active.
 * Production live path: LiveBetExecutor (Playwright / browser-worker).
 * Dry-run path: BetExecutor + MockBetPlacementAdapter.
 * Never run both placement paths for the same round.
 */

import { getLogger } from '../observability/logger.js';

export type ExecutionMode = 'live' | 'dry-run' | 'observe-only' | 'maintenance';

export interface PlacementPath {
  /** Active path name for telemetry */
  path: 'live-bet-executor' | 'mock-bet-executor' | 'none';
}

export function resolvePlacementPath(opts: {
  mode: ExecutionMode;
  liveBound?: boolean;
  mockBound?: boolean;
}): PlacementPath {
  const logger = getLogger();
  if (opts.mode === 'live') {
    if (!opts.liveBound) {
      logger.warn(
        { component: 'BetExecutorFactory' },
        'Live mode without LiveBetExecutor bound — no placement path'
      );
      return { path: 'none' };
    }
    return { path: 'live-bet-executor' }; // LiveBetExecutor owns Playwright path
  }
  if (opts.mode === 'dry-run' && opts.mockBound) {
    return { path: 'mock-bet-executor' };
  }
  return { path: 'none' };
}
