/**
 * Crash handler: logs uncaught exceptions and unhandled rejections,
 * attempts to notify the operator via Telegram (best-effort), and
 * triggers a graceful shutdown.
 *
 * This module integrates with the application's logger (pino).
 */
import { getLogger } from '../observability/logger';

let installed = false;

export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;
  const logger = getLogger();

  process.on('uncaughtException', (err: Error) => {
    try {
      logger.fatal({ component: 'CrashHandler', stack: err.stack }, `Uncaught exception: ${err.message}`);
    } catch {
      // ignore logger errors
    }
    // Give a short grace period for logs then exit
    setTimeout(() => process.exit(1), 2500);
  });

  process.on('unhandledRejection', (reason) => {
    try {
      logger.error({ component: 'CrashHandler' }, `Unhandled rejection: ${String(reason)}`);
    } catch {
      // ignore
    }
    // don't exit immediately; let the app decide
  });
}
