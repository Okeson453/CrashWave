import { getPoolStats } from './client.js';
import { dbPoolActive, dbPoolIdle, dbPoolTotal, dbPoolWaiting } from '../observability/metrics/registry.js';

export function refreshPoolMetrics(): void {
  try {
    const s = getPoolStats();
    dbPoolTotal.set(s.total);
    dbPoolIdle.set(s.idle);
    dbPoolWaiting.set(s.waiting);
    dbPoolActive.set(s.active);
  } catch {
    /* pool not ready */
  }
}
