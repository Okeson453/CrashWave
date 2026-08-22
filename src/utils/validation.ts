import { ValidationError } from './errors';

export function assertNotEmpty(value: string | null | undefined, fieldName: string): void {
  if (!value || value.trim().length === 0) {
    throw new ValidationError(`${fieldName} cannot be empty`, 'VALIDATION_ERROR', { metadata: { field: fieldName } });
  }
}

export function assertPositive(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`${fieldName} must be a positive number`, 'VALIDATION_ERROR', { metadata: { field: fieldName, value } });
  }
}

export function assertNonNegative(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${fieldName} must be a non-negative number`, 'VALIDATION_ERROR', { metadata: { field: fieldName, value } });
  }
}

export function assertInRange(value: number, min: number, max: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(
      `${fieldName} must be between ${min} and ${max}`,
      'VALIDATION_ERROR',
      { metadata: { field: fieldName, value, min, max } }
    );
  }
}

export function assertOneOf<T>(value: T, allowed: T[], fieldName: string): void {
  if (!allowed.includes(value)) {
    throw new ValidationError(
      `${fieldName} must be one of: ${allowed.join(', ')}`,
      'VALIDATION_ERROR',
      { metadata: { field: fieldName, value, allowed } }
    );
  }
}

export function assertValidUUID(value: string, fieldName: string): void {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(value)) {
    throw new ValidationError(`${fieldName} must be a valid UUID`, 'VALIDATION_ERROR', { metadata: { field: fieldName, value } });
  }
}

export function assertValidDate(value: string | Date, fieldName: string): void {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(d.getTime())) {
    throw new ValidationError(`${fieldName} must be a valid date`, 'VALIDATION_ERROR', { metadata: { field: fieldName, value } });
  }
}

export function sanitizeString(value: string): string {
  return value.replace(/[<>"']/g, '');
}

export function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isValidString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
