/**
 * Contention / dual-owner tests for DistributedMutex.
 * Uses two independent mutex instances with shared in-memory semantics via sequential acquire.
 * When REDIS_URL is set, additionally exercises real Redis locking.
 */

import { DistributedMutex } from '../../../src/core/distributed-mutex';

describe('DistributedMutex contention', () => {
  it('two instances cannot both hold the same logical resource (in-memory isolation note)', async () => {
    // In-memory locks are process-local; each instance has its own map.
    // Document that multi-instance requires Redis. This test verifies single-instance exclusion.
    const m = new DistributedMutex({
      allowInMemoryFallback: true,
      lockTimeoutMs: 1000,
      retryCount: 0,
    });
    const a = await m.acquire('shared');
    const b = await m.acquire('shared');
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    await a!.release();
    const c = await m.acquire('shared');
    expect(c).not.toBeNull();
    await c!.release();
    await m.disconnect();
  });

  it('rapid acquire/release cycles remain exclusive', async () => {
    const m = new DistributedMutex({
      allowInMemoryFallback: true,
      lockTimeoutMs: 5000,
      retryCount: 3,
      retryDelayMs: 5,
    });
    let concurrent = 0;
    let maxConcurrent = 0;

    const workers = Array.from({ length: 20 }, async () => {
      const h = await m.acquire('rapid');
      if (!h) return;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      await h.release();
    });
    await Promise.all(workers);
    expect(maxConcurrent).toBe(1);
    await m.disconnect();
  });

  it('wrong-owner release does not drop another holder (token safety)', async () => {
    const m = new DistributedMutex({
      allowInMemoryFallback: true,
      lockTimeoutMs: 2000,
      retryCount: 0,
    });
    const h1 = await m.acquire('token-safe');
    expect(h1).not.toBeNull();
    // Simulate stale handle release after expiry by releasing then re-acquiring
    await h1!.release();
    const h2 = await m.acquire('token-safe');
    expect(h2).not.toBeNull();
    // Releasing old handle should be no-op if tokens differ (local map checks token)
    await h1!.release();
    const stillHeld = await m.acquire('token-safe');
    // If token check works, h2 still holds → stillHeld null
    expect(stillHeld).toBeNull();
    await h2!.release();
    await m.disconnect();
  });
});

const redisUrl = process.env.REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('DistributedMutex Redis integration', () => {
  it('two mutex clients cannot both own the same Redis lock', async () => {
    const opts = {
      redisUrl: redisUrl!,
      lockTimeoutMs: 3000,
      retryCount: 1,
      retryDelayMs: 50,
      allowInMemoryFallback: false,
    };
    const a = new DistributedMutex(opts);
    const b = new DistributedMutex(opts);
    const resource = `test-lock-${Date.now()}`;
    const h1 = await a.acquire(resource);
    expect(h1).not.toBeNull();
    const h2 = await b.acquire(resource);
    expect(h2).toBeNull();
    await h1!.release();
    const h3 = await b.acquire(resource);
    expect(h3).not.toBeNull();
    await h3!.release();
    await a.disconnect();
    await b.disconnect();
  });
});
