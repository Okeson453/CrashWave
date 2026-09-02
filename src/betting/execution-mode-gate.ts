/**
 * Hard safety gate for real-money execution.
 * Dry-run / non-live modes must never place real bets or cash-outs.
 */
import { getLogger } from '../observability/logger';

const logger = getLogger();

export function isDryRunMode(requestDryRun?: boolean): boolean {
  const mode = (process.env.APP_SYSTEM__MODE ?? process.env.EXECUTION_MODE ?? '').toLowerCase();
  return (
    mode === 'dry-run' ||
    process.env.DRY_RUN === 'true' ||
    process.env.DRY_RUN === '1' ||
    requestDryRun === true
  );
}

export function isRealExecutionAllowed(requestDryRun?: boolean, mode?: string): boolean {
  const effectiveMode = (mode ?? process.env.APP_SYSTEM__MODE ?? process.env.EXECUTION_MODE ?? '').toLowerCase();
  const allowReal =
    process.env.ALLOW_REAL_EXECUTION === 'true' || process.env.ALLOW_REAL_EXECUTION === '1';
  if (isDryRunMode(requestDryRun)) return false;
  if (effectiveMode !== 'live') return false;
  return allowReal;
}

/** Returns null if allowed; otherwise a human-readable block reason. */
export function realExecutionBlockReason(
  requestDryRun?: boolean,
  mode?: string,
  component = 'ExecutionGate'
): string | null {
  const effectiveMode = (mode ?? process.env.APP_SYSTEM__MODE ?? process.env.EXECUTION_MODE ?? '').toLowerCase();
  const dryRun = isDryRunMode(requestDryRun);
  const allowReal =
    process.env.ALLOW_REAL_EXECUTION === 'true' || process.env.ALLOW_REAL_EXECUTION === '1';
  if (dryRun) {
    logger.warn({ component, mode: effectiveMode, dryRun: true }, 'Blocked real execution — dry-run');
    return 'DRY_RUN: real execution disabled';
  }
  if (effectiveMode !== 'live' || !allowReal) {
    logger.warn(
      { component, mode: effectiveMode, allowReal },
      'Blocked real execution — ALLOW_REAL_EXECUTION not enabled or mode not live'
    );
    return 'Real execution blocked (require live mode and ALLOW_REAL_EXECUTION=true)';
  }
  return null;
}
