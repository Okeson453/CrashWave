import { DistributedMutex } from '../../../src/core/distributed-mutex';

describe('DistributedMutex (in-memory fallback)', () => {
  let mutex: DistributedMutex;
  beforeEach(() => {
    mutex = new DistributedMutex({
      allowInMemoryFallback: true,
      lockTimeoutMs: 500,
      retryCount: 2,
      retryDelayMs: 20,
    });
  });
  afterEach(async () => { await mutex.disconnect(); });

  it('acquires and releases a lock', async () => {
    const handle = await mutex.acquire('resource-a');
    expect(handle).not.toBeNull();
    await handle!.release();
    const handle2 = await mutex.acquire('resource-a');
    expect(handle2).not.toBeNull();
    await handle2!.release();
  });

  it('prevents concurrent ownership of the same resource', async () => {
    const local = new DistributedMutex({
      allowInMemoryFallback: true,
      lockTimeoutMs: 5_000,
      retryCount: 0,
      retryDelayMs: 10,
    });
    const h1 = await local.acquire('resource-b-exclusive');
    expect(h1).not.toBeNull();
    const h2 = await local.acquire('resource-b-exclusive');
    expect(h2).toBeNull();
    await h1!.release();
    const h3 = await local.acquire('resource-b-exclusive');
    expect(h3).not.toBeNull();
    await h3!.release();
  });

  it('allows independent resources concurrently', async () => {
    const a = await mutex.acquire('r1');
    const b = await mutex.acquire('r2');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });

  it('auto-expires local locks', async () => {
    const short = new DistributedMutex({
      allowInMemoryFallback: true,
      lockTimeoutMs: 50,
      retryCount: 0,
    });
    const h = await short.acquire('expire-me');
    expect(h).not.toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    const h2 = await short.acquire('expire-me');
    expect(h2).not.toBeNull();
    await h2!.release();
    await short.disconnect();
  });

  it('exposes metrics', async () => {
    const h = await mutex.acquire('metrics');
    await h!.release();
    const m = mutex.getMetrics();
    expect(m.acquisitions).toBeGreaterThanOrEqual(1);
    expect(m.releases).toBeGreaterThanOrEqual(1);
  });
});
