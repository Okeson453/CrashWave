/**
 * Custom error types for the BC.Game Crash Automation system.
 *
 * All errors extend AppError which carries:
 * - A machine-readable code
 * - A severity level
 * - Optional metadata for telemetry
 * - Stack trace preservation
 */

export interface ErrorOptions {
  code?: string;
  isCritical?: boolean;
  isTransient?: boolean;
  metadata?: Record<string, unknown>;
  cause?: Error;
}

/**
 * Base application error.
 */
export class AppError extends Error {
  readonly code: string;
  readonly isCritical: boolean;
  readonly isTransient: boolean;
  readonly metadata: Record<string, unknown>;
  readonly cause?: Error;

  constructor(
    message: string,
    code: string = 'UNKNOWN_ERROR',
    options: ErrorOptions = {}
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.isCritical = options.isCritical ?? false;
    this.isTransient = options.isTransient ?? false;
    this.metadata = options.metadata ?? {};
    this.cause = options.cause;

    // Preserve stack trace (V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      isCritical: this.isCritical,
      isTransient: this.isTransient,
      metadata: this.metadata,
      stack: this.stack,
      cause: this.cause?.message,
    };
  }
}

/**
 * Critical errors halt the system and require operator intervention.
 */
export class CriticalError extends AppError {
  constructor(message: string, code: string = 'CRITICAL_ERROR', options: Omit<ErrorOptions, 'isCritical'> = {}) {
    super(message, code, { ...options, isCritical: true });
  }
}

/**
 * Operational errors are expected business-logic failures (daily limit reached, insufficient balance).
 */
export class TransientError extends AppError {
  constructor(message: string, code: string = 'TRANSIENT_ERROR', options: Omit<ErrorOptions, 'isTransient'> = {}) {
    super(message, code, { ...options, isTransient: true });
  }
}

export class OperationalError extends AppError {
  constructor(message: string, code: string = 'OPERATIONAL_ERROR', options: ErrorOptions = {}) {
    super(message, code, options);
  }
}

/**
 * Validation errors indicate malformed input or state.
 */
export class ValidationError extends AppError {
  constructor(message: string, code: string = 'VALIDATION_ERROR', options: ErrorOptions = {}) {
    super(message, code, options);
  }
}

/**
 * Conflict errors indicate concurrent modification or duplicate operations.
 */
export class ConflictError extends AppError {
  constructor(message: string, metadata: Record<string, unknown> = {}) {
    super(message, 'CONFLICT_ERROR', { metadata });
  }
}

/**
 * NotFound errors indicate a missing entity.
 */
export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND_ERROR', { metadata: { entity, id } });
  }
}

/**
 * Determine if an error is retryable.
 */
export function isRetryableError(error: unknown): boolean {
  return error instanceof AppError && error.isTransient;
}

/**
 * Determine if an error should halt the system.
 */
/**
 * Timeout errors indicate an operation exceeded its time budget.
 */
export class TimeoutError extends AppError {
  constructor(message: string, code: string = 'TIMEOUT_ERROR', options: ErrorOptions = {}) {
    super(message, code, { ...options, isTransient: true });
  }
}

/**
 * Live execution errors indicate a failure during real-money DOM interaction.
 */
export class LiveExecutionError extends AppError {
  constructor(message: string, code: string = 'LIVE_EXECUTION_ERROR', options: ErrorOptions = {}) {
    super(message, code, { ...options, isTransient: true });
  }
}

export function isHaltingError(error: unknown): boolean {
  return error instanceof AppError && error.isCritical;
}
