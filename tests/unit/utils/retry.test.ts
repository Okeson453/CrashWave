import { withRetry, CircuitBreaker, isRetryable } from '../../../src/utils/retry';
import { TransientError } from '../../../src/utils/errors';

describe('withRetry', () => {
  it('should return result on success', async () => {
    const result = await withRetry(async () => 'success');
    expect(result).toBe('success');
  });

  it('should retry on TransientError', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) {
        throw new TransientError('temporary', 'TEMP');
      }
      return 'recovered';
    }, { maxRetries: 5, baseDelayMs: 10 });
    expect(result).toBe('recovered');
    expect(attempts).toBe(3);
  });

  it('should throw after max retries', async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new TransientError('always fails', 'ALWAYS');
      }, { maxRetries: 2, baseDelayMs: 10 })
    ).rejects.toThrow('always fails');
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it('should not retry non-retryable errors', async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error('fatal');
      }, { maxRetries: 3, baseDelayMs: 10 })
    ).rejects.toThrow('fatal');
    expect(attempts).toBe(1);
  });

  it('should call onRetry callback', async () => {
    const onRetry = jest.fn();
    let attempts = 0;
    await withRetry(async () => {
      attempts++;
      if (attempts < 2) throw new TransientError('retry', 'R');
      return 'ok';
    }, { maxRetries: 3, baseDelayMs: 10, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(TransientError), expect.any(Number));
  });
});

describe('CircuitBreaker', () => {
  it('should start in CLOSED state', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.canExecute()).toBe(true);
  });

  it('should open after threshold failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10000 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('OPEN');
    expect(cb.canExecute()).toBe(false);
  });

  it('should allow execution after success in half-open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50, halfOpenMaxCalls: 2 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('OPEN');
    await new Promise(r => setTimeout(r, 60));
    expect(cb.canExecute()).toBe(true);
    expect(cb.getState()).toBe('HALF_OPEN');
    cb.recordSuccess();
    cb.recordSuccess();
    expect(cb.getState()).toBe('CLOSED');
  });

  it('should go back to OPEN on failure in HALF_OPEN', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    cb.recordFailure();
    await new Promise(r => setTimeout(r, 60));
    cb.recordFailure();
    expect(cb.getState()).toBe('OPEN');
  });
});

describe('isRetryable', () => {
  it('should identify TransientError as retryable', () => {
    expect(isRetryable(new TransientError('test', 'T'))).toBe(true);
  });

  it('should identify regular Error as non-retryable', () => {
    expect(isRetryable(new Error('test'))).toBe(false);
  });

  it('should respect custom shouldRetry', () => {
    expect(isRetryable(new Error('special'), { shouldRetry: () => true })).toBe(true);
  });
});
