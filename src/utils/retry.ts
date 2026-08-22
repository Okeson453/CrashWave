import { TransientError } from './errors';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  jitterFactor?: number;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  retryableErrors?: string[];
  shouldRetry?: (error: Error) => boolean;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMaxCalls?: number;
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private lastFailureTime: number | null = null;
  private halfOpenCalls = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxCalls: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
    this.halfOpenMaxCalls = options.halfOpenMaxCalls ?? 3;
  }

  canExecute(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (this.lastFailureTime && Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenCalls = 0;
        return true;
      }
      return false;
    }
    if (this.state === 'HALF_OPEN') {
      return this.halfOpenCalls < this.halfOpenMaxCalls;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.halfOpenCalls++;
      if (this.halfOpenCalls >= this.halfOpenMaxCalls) {
        this.state = 'CLOSED';
        this.failures = 0;
        this.lastFailureTime = null;
      }
    } else {
      this.failures = 0;
      this.lastFailureTime = null;
    }
  }

  recordFailure(): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.lastFailureTime = Date.now();
      return;
    }
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

function calculateDelay(attempt: number, options: RetryOptions): number {
  const baseDelay = options.baseDelayMs ?? 1000;
  const maxDelay = options.maxDelayMs ?? 30000;
  const jitterEnabled = options.jitter ?? true;
  const jitterFactor = options.jitterFactor ?? 0.3;

  const exponential = baseDelay * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxDelay);

  if (!jitterEnabled) return capped;

  const jitterAmount = capped * jitterFactor;
  return capped + (Math.random() * jitterAmount * 2 - jitterAmount);
}

export function isRetryable(error: Error, options: RetryOptions = {}): boolean {
  if (options.shouldRetry) {
    return options.shouldRetry(error);
  }
  if (error instanceof TransientError) {
    return true;
  }
  if (options.retryableErrors && options.retryableErrors.includes(error.name)) {
    return true;
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (error) {
      lastError = error as Error;
      if (attempt > maxRetries || !isRetryable(lastError, options)) {
        throw lastError;
      }
      const delayMs = calculateDelay(attempt, options);
      if (options.onRetry) {
        options.onRetry(attempt, lastError, delayMs);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError!;
}

export async function withCircuitBreaker<T>(
  breaker: CircuitBreaker,
  fn: () => Promise<T>
): Promise<T> {
  if (!breaker.canExecute()) {
    throw new TransientError('Circuit breaker is OPEN', 'CIRCUIT_OPEN');
  }

  try {
    const result = await fn();
    breaker.recordSuccess();
    return result;
  } catch (error) {
    breaker.recordFailure();
    throw error;
  }
}
