import { createHash } from 'crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha512(input: string): string {
  return createHash('sha512').update(input).digest('hex');
}

export function deterministicHash(inputs: (string | number | boolean)[]): string {
  const normalized = inputs.map((i) => String(i)).join('|');
  return sha256(normalized);
}

export function hashForAuditTrail(
  actor: string,
  action: string,
  entityType: string,
  entityId: string,
  timestamp: string,
  payload: string
): string {
  return sha256(`${actor}:${action}:${entityType}:${entityId}:${timestamp}:${payload}`);
}

export function hashForIdempotencyKey(sessionId: string, roundId: string): string {
  return sha256(`idempotency:${sessionId}:${roundId}`);
}

export function hashForConfigVersion(
  stake: number,
  target: number,
  maxDaily: number,
  changedBy: string,
  timestamp: string
): string {
  return sha256(`config:${stake}:${target}:${maxDaily}:${changedBy}:${timestamp}`);
}
