/**
 * Verifies only one process can hold crash:active-instance.
 * Requires REDIS_URL.
 *
 * Usage: REDIS_URL=redis://localhost:6379 npx tsx scripts/verify-single-instance.ts
 */

import Redis from 'ioredis';
import { InstanceLock } from '../src/core/instance-lock';

async function main(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.error('REDIS_URL required');
    process.exit(2);
  }

  const redisA = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  const redisB = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  await redisA.connect();
  await redisB.connect();

  const lockA = new InstanceLock({ redis: redisA, instanceId: 'verify-A', ttlMs: 10_000 });
  const lockB = new InstanceLock({ redis: redisB, instanceId: 'verify-B', ttlMs: 10_000 });

  const a = await lockA.tryAcquire();
  const b = await lockB.tryAcquire();

  console.log(JSON.stringify({ firstAcquired: a, secondAcquired: b, expectSecondFalse: true }));

  await lockA.release();
  const b2 = await lockB.tryAcquire();
  console.log(JSON.stringify({ afterReleaseSecondAcquired: b2, expectTrue: true }));

  await lockB.release();
  await redisA.quit();
  await redisB.quit();

  if (!a || b || !b2) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
