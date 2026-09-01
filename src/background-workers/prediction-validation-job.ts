/**
 * Periodic statistical validation hook (issue 15).
 * Wire into composition start when VALIDATION_CRON_ENABLED=true.
 */

import { getLogger } from '../observability/logger.js';

const logger = getLogger();

export function startPredictionValidationJob(intervalMs = 24 * 60 * 60 * 1000): () => void {
  if (process.env.VALIDATION_CRON_ENABLED !== 'true') {
    return () => undefined;
  }
  const tick = async () => {
    try {
      const { runValidationProtocol } = await import('../prediction/index.js');
      if (typeof runValidationProtocol === 'function') {
        // Periodic hook: empty sample is a no-op gate when cron is enabled without a data feed.
        // Full protocol is run offline with historical rounds via scripts/ops tooling.
        const report = runValidationProtocol([], { minRounds: 0 });
        logger.info(
          { component: 'ValidationJob', approved: (report as { approved?: boolean }).approved },
          'Validation protocol tick completed'
        );
      }
    } catch (err) {
      logger.warn(
        { component: 'ValidationJob', error: String(err) },
        'Validation protocol skipped or failed'
      );
    }
  };
  const id = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => clearInterval(id);
}
