import { NotificationQueue } from '../../../src/notifications/queue';

describe('NotificationQueue', () => {
  it('enqueues and dequeues in priority order', () => {
    const q = new NotificationQueue({ maxSize: 10, flushIntervalMs: 0, retryAttempts: 3, retryDelayMs: 10 });
    q.enqueue('normal-msg', 'normal');
    q.enqueue('critical-msg', 'critical');
    q.enqueue('low-msg', 'low');
    expect(q.dequeue()?.priority).toBe('critical');
  });

  it('drops oldest when full', () => {
    const q = new NotificationQueue({ maxSize: 2, flushIntervalMs: 0, retryAttempts: 1, retryDelayMs: 10 });
    q.enqueue('a', 'normal');
    q.enqueue('b', 'normal');
    q.enqueue('c', 'normal');
    expect(q.size()).toBe(2);
  });

  it('flushes successfully delivered messages', async () => {
    const delivered: string[] = [];
    const q = new NotificationQueue({
      maxSize: 10, flushIntervalMs: 0, retryAttempts: 3, retryDelayMs: 5,
      deliver: async (msg) => { delivered.push(msg); return true; },
    });
    q.enqueue('one');
    q.enqueue('two');
    const result = await q.flush();
    expect(result.delivered).toBe(2);
    expect(delivered).toEqual(['one', 'two']);
  });

  it('moves exhausted retries to dead-letter', async () => {
    const q = new NotificationQueue({
      maxSize: 10, flushIntervalMs: 0, retryAttempts: 2, retryDelayMs: 1,
      deliver: async () => false,
    });
    q.enqueue('fail-me', 'high');
    await q.flush();
    await new Promise((r) => setTimeout(r, 5));
    await q.flush();
    await new Promise((r) => setTimeout(r, 10));
    await q.flush();
    expect(q.deadLetterSize()).toBeGreaterThanOrEqual(1);
  });

  it('reports metrics', async () => {
    const q = new NotificationQueue({
      maxSize: 5, flushIntervalMs: 0, retryAttempts: 1, retryDelayMs: 1,
      deliver: async () => true,
    });
    q.enqueue('x');
    await q.flush();
    expect(q.getMetrics().delivered).toBe(1);
  });
});
