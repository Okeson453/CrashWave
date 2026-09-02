/**
 * Single decision point for which bet execution path is active.
 * Production live path: LiveBetExecutor (Playwright).
 * Dry-run path: dry-run controller (not this factory) + optional mock adapter.
 * Never run both placement paths for the same round.
 */

import { getLogger } from '../observability/logger.js';
import type { LiveBetExecutor } from './live-executor.js';

export type ExecutionMode = 'live' | 'dry-run' | 'observe-only' | 'maintenance';

export interface PlacementPath {
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
    return { path: 'live-bet-executor' };
  }
  if (opts.mode === 'dry-run' && opts.mockBound) {
    return { path: 'mock-bet-executor' };
  }
  return { path: 'none' };
}

export function isLiveExecutorReady(executor: LiveBetExecutor | null | undefined): boolean {
  return Boolean(executor);
}
