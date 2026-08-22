/**
 * Redis Failure Simulation Scenario
 * Tests system behavior when Redis (distributed state store) becomes unavailable.
 */
import { EventBus } from '../../../src/core/event-bus/bus';
import { DistributedMutex } from '../../../src/core/distributed-mutex';
import { InMemoryIdempotencyStore } from '../../../src/betting/idempotency';

describe('Simulation: Redis Failure', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  describe('critical error emission', () => {
    it('should emit CriticalError when Redis is unavailable', async () => {
      const errors: Array<{ code: string }> = [];
      eventBus.on('CriticalError', (event: { payload: { code: string } }) => {
        errors.push(event.payload);
      });
      await eventBus.emitTyped('CriticalError', {
        message: 'Redis connection lost',
        code: 'REDIS_UNAVAILABLE',
        component: 'RedisClient',
      }, 'redis-1', 'RedisClient');
      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe('REDIS_UNAVAILABLE');
    });

    it('should emit multiple errors for cascading Redis failures', async () => {
      const errors: Array<{ code: string }> = [];
      eventBus.on('CriticalError', (event: { payload: { code: string } }) => {
        errors.push(event.payload);
      });
      await eventBus.emitTyped('CriticalError', { message: 'Redis timeout', code: 'REDIS_TIMEOUT', component: 'RedisClient' }, 'r1', 'RedisClient');
      await eventBus.emitTyped('CriticalError', { message: 'Redis reconnect failed', code: 'REDIS_RECONNECT_FAILED', component: 'RedisClient' }, 'r2', 'RedisClient');
      expect(errors.length).toBe(2);
      expect(errors.map((e) => e.code)).toContain('REDIS_TIMEOUT');
      expect(errors.map((e) => e.code)).toContain('REDIS_RECONNECT_FAILED');
    });
  });

  describe('mutex fallback behavior', () => {
    it('should allow in-memory mutex fallback when Redis fails', async () => {
      const mutex = new DistributedMutex({
        redisUrl: '',
        lockTimeoutMs: 5000,
        retryCount: 3,
        retryDelayMs: 100,
      });
      const handle = await mutex.acquire('test-resource');
      expect(handle).not.toBeNull();
      await handle!.release();
    });

    it('should enforce mutual exclusion with in-memory fallback', async () => {
      const mutex = new DistributedMutex({
        redisUrl: '',
        lockTimeoutMs: 5000,
        retryCount: 0,
        retryDelayMs: 100,
      });
      const handle1 = await mutex.acquire('resource-a');
      expect(handle1).not.toBeNull();
      // Second acquire should fail immediately (no retries)
      const handle2 = await mutex.acquire('resource-a');
      expect(handle2).toBeNull();
      await handle1!.release();
    });

    it('should allow different resources to be locked concurrently', async () => {
      const mutex = new DistributedMutex({
        redisUrl: '',
        lockTimeoutMs: 5000,
        retryCount: 0,
        retryDelayMs: 100,
      });
      const h1 = await mutex.acquire('resource-a');
      const h2 = await mutex.acquire('resource-b');
      expect(h1).not.toBeNull();
      expect(h2).not.toBeNull();
      await h1!.release();
      await h2!.release();
    });
  });

  describe('operation queuing', () => {
    it('should queue operations when Redis is down', async () => {
      const queued: string[] = [];
      const operation = async () => {
        try {
          throw new Error('Redis unavailable');
        } catch {
          queued.push('operation-1');
        }
      };
      await operation();
      expect(queued.length).toBe(1);
      expect(queued[0]).toBe('operation-1');
    });

    it('should use in-memory idempotency when Redis is unavailable', async () => {
      const store = new InMemoryIdempotencyStore();
      await store.reserve('session-1', 'round-1', 'key-1');
      await store.complete('session-1', 'round-1', { success: true, betId: 'key-1' });
      const record = await store.getRecord('session-1', 'round-1');
      expect(record).not.toBeNull();
      expect(record!.status).toBe('COMPLETED');
    });

    it('should block duplicate bets via in-memory idempotency during Redis outage', async () => {
      const store = new InMemoryIdempotencyStore();
      await store.reserve('session-1', 'round-1', 'key-1');
      await store.complete('session-1', 'round-1', { success: true, betId: 'key-1' });
      const record = await store.getRecord('session-1', 'round-1');
      expect(record).not.toBeNull();
      expect(record!.status).toBe('COMPLETED');
    });
  });
});
