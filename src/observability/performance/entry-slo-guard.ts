/**
 * Entry path latency SLO guard — sheath when p99 > 300ms.
 */

import { globalEntryLatencyWindow } from './latency.js';
import { getLogger } from '../logger.js';
import type { SheathTrigger } from '../../core/sheath-mode/types.js';

const ENTRY_P99_SLO_MS = Number(process.env.ENTRY_P99_SLO_MS ?? 300);

export function checkEntryLatencySlo(sheathMode: {
  reportTriggers?: (triggers: SheathTrigger[]) => void;
}): void {
  const p99 = globalEntryLatencyWindow.p99();
  if (p99 <= ENTRY_P99_SLO_MS) return;
  getLogger().warn(
    { component: 'EntrySloGuard', p99, slo: ENTRY_P99_SLO_MS },
    'Entry path p99 exceeded SLO'
  );
  try {
    sheathMode.reportTriggers?.([
      {
        id: 'system_health_degradation',
        severity: 'high',
        message: `entry p99 ${Math.round(p99)}ms > ${ENTRY_P99_SLO_MS}ms`,
        detectedAt: new Date().toISOString(),
      },
    ]);
  } catch {
    /* */
  }
}
