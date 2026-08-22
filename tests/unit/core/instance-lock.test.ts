import { InstanceLock } from '../../../src/core/instance-lock';

describe('InstanceLock', () => {
  it('exposes token and instance id', () => {
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn(),
      eval: jest.fn().mockResolvedValue(1),
    } as unknown as import('ioredis').default;
    const lock = new InstanceLock({ redis, instanceId: 'test-1' });
    expect(lock.getInstanceId()).toBe('test-1');
    expect(lock.getToken()).toHaveLength(32);
  });

  it('acquires when SET NX succeeds', async () => {
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn(),
      eval: jest.fn().mockResolvedValue(1),
    } as unknown as import('ioredis').default;
    const lock = new InstanceLock({ redis });
    const ok = await lock.tryAcquire();
    expect(ok).toBe(true);
    expect(lock.isHeld()).toBe(true);
    await lock.release();
  });

  it('fails when lock held by another', async () => {
    const redis = {
      set: jest.fn().mockResolvedValue(null),
      get: jest.fn().mockResolvedValue('{"instanceId":"other"}'),
      eval: jest.fn(),
    } as unknown as import('ioredis').default;
    const lock = new InstanceLock({ redis });
    const ok = await lock.tryAcquire();
    expect(ok).toBe(false);
  });
});
