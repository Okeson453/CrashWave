/**
 * Bounded worker dead-letter queue (Redis list or in-memory).
 */

import { getLogger } from '../observability/logger.js';
import { workerDlqTotal } from '../observability/metrics/workers.js';

const MAX = 10_000;
const KEY = process.env.WORKER_DLQ_REDIS_KEY ?? 'crash:worker:dlq';
const memory: string[] = [];
const logger = getLogger();

export interface DlqItem {
  worker: string;
  payload: Record<string, unknown>;
  error: string;
  eventId?: string;
  at: string;
}

export async function enqueueDeadLetter(item: DlqItem): Promise<void> {
  workerDlqTotal.inc({ worker: item.worker });
  const raw = JSON.stringify(item);
  try {
    const { getRedisClient } = await import('../persistence/redis-client.js');
    const redis = getRedisClient();
    await redis.lpush(KEY, raw);
    await redis.ltrim(KEY, 0, MAX - 1);
  } catch {
    memory.unshift(raw);
    if (memory.length > MAX) memory.length = MAX;
    logger.warn(
      { component: 'WorkerDLQ', worker: item.worker },
      'DLQ in-memory (redis unavailable)'
    );
  }
}

export async function listDeadLetters(limit = 50): Promise<DlqItem[]> {
  try {
    const { getRedisClient } = await import('../persistence/redis-client.js');
    const redis = getRedisClient();
    const rows = await redis.lrange(KEY, 0, limit - 1);
    return rows.map((r) => JSON.parse(r) as DlqItem);
  } catch {
    return memory.slice(0, limit).map((r) => JSON.parse(r) as DlqItem);
  }
}
