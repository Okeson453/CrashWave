import {
  Mutex,
  Semaphore,
  withTimeout,
  promisePool,
  Deferred,
  debounce,
  throttle,
} from '../../../src/utils/async';

describe('Mutex', () => {
  it('should acquire and release', async () => {
    const mutex = new Mutex();
    await mutex.acquire();
    expect(mutex.isLocked()).toBe(true);
    mutex.release();
    expect(mutex.isLocked()).toBe(false);
  });

  it('should queue concurrent acquires', async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const p1 = mutex.acquire().then(() => {
      order.push(1);
      mutex.release();
    });

    const p2 = mutex.acquire().then(() => {
      order.push(2);
      mutex.release();
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });
});

describe('Semaphore', () => {
  it('should allow up to N concurrent', async () => {
    const sem = new Semaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const fn = async () => {
      await sem.acquire();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 20));
      concurrent--;
      sem.release();
    };

    await Promise.all([fn(), fn(), fn(), fn()]);
    expect(maxConcurrent).toBe(2);
  });
});

describe('withTimeout', () => {
  it('should resolve if promise resolves in time', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 100);
    expect(result).toBe('ok');
  });

  it('should reject if promise takes too long', async () => {
    await expect(
      withTimeout(new Promise(r => setTimeout(() => r('late'), 200)), 50)
    ).rejects.toThrow('Operation timed out');
  });
});

describe('promisePool', () => {
  it('should process items with limited concurrency', async () => {
    const items = [1, 2, 3, 4, 5];
    let concurrent = 0;
    let maxConcurrent = 0;

    const results = await promisePool(items, 2, async (item) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 10));
      concurrent--;
      return item * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maxConcurrent).toBe(2);
  });
});

describe('Deferred', () => {
  it('should resolve', async () => {
    const d = new Deferred<string>();
    d.resolve('done');
    expect(await d.promise).toBe('done');
  });

  it('should reject', async () => {
    const d = new Deferred<string>();
    d.reject(new Error('fail'));
    await expect(d.promise).rejects.toThrow('fail');
  });
});

describe('debounce', () => {
  it('should delay execution', async () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 50);
    debounced('a');
    debounced('b');
    debounced('c');
    expect(fn).not.toHaveBeenCalled();
    await new Promise(r => setTimeout(r, 60));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });
});

describe('throttle', () => {
  it('should limit execution rate', async () => {
    const fn = jest.fn();
    const throttled = throttle(fn, 100);
    throttled('a');
    throttled('b');
    throttled('c');
    expect(fn).toHaveBeenCalledTimes(1);
    await new Promise(r => setTimeout(r, 110));
    throttled('d');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
