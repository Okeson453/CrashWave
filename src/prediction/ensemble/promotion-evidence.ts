/**
 * Ensemble advanced models stay OFF unless DB evidence row exists.
 */

import { getPool } from '../../persistence/client.js';
import { getLogger } from '../../observability/logger.js';
import type { EnsembleFlags } from './ensemble-orchestrator.js';

const logger = getLogger();

const DEFAULT_OFF: EnsembleFlags = {
  enableAutocorrelation: false,
  enableMarkov: false,
  enableSpectral: false,
  enableEntropy: false,
  enableStreak: false,
};

export async function loadApprovedEnsembleFlags(
  base: EnsembleFlags = DEFAULT_OFF
): Promise<EnsembleFlags> {
  const flags = { ...base };
  try {
    const r = await getPool().query<{ model_name: string }>(
      `SELECT model_name FROM model_promotion_evidence WHERE approved_at IS NOT NULL`
    );
    for (const row of r.rows) {
      const n = row.model_name.toLowerCase();
      if (n.includes('markov')) flags.enableMarkov = true;
      if (n.includes('spectral')) flags.enableSpectral = true;
      if (n.includes('entropy')) flags.enableEntropy = true;
      if (n.includes('streak')) flags.enableStreak = true;
    }
    logger.info(
      { component: 'PromotionEvidence', flags, approved: r.rows.length },
      'Ensemble flags loaded from evidence table'
    );
  } catch {
    logger.debug(
      { component: 'PromotionEvidence' },
      'model_promotion_evidence unavailable — flags stay off'
    );
  }
  return flags;
}
