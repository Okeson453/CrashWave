/**
 * Ephemeral login credentials — personal-use stub.
 *
 * The advanced Crash build has a full ephemeral-credentials manager
 * with zeroization, TTL, and secure memory handling (spec §15.2).
 * In personal use, the operator provides credentials directly via
 * the /login Telegram command. The credentials are held in memory
 * only, used immediately for the browser login flow, and never
 * written to disk, DB, Redis, or logs.
 *
 * This stub preserves the interface so browser/manager.ts and
 * browser/login-test-pipeline.ts can import it, but the secure
 * memory handling is a no-op (Node.js strings are immutable; true
 * zeroization requires native addons which are out of scope for
 * personal use).
 */

export interface EphemeralLoginPayload {
  email: string;
  password: string;
  /** Telegram chat that initiated the flow */
  chatId: number;
  /** Unix ms when the payload was created */
  createdAt: number;
  /** Unix ms when the payload should be discarded */
  expiresAt: number;
}

const activePayloads = new Map<number, EphemeralLoginPayload>();

export function createEphemeralLogin(
  email: string,
  password: string,
  chatId: number,
  ttlMs = 5 * 60 * 1000
): EphemeralLoginPayload {
  const now = Date.now();
  const payload: EphemeralLoginPayload = {
    email,
    password,
    chatId,
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  activePayloads.set(chatId, payload);
  return payload;
}

export function consumeEphemeralLogin(chatId: number): EphemeralLoginPayload | null {
  const payload = activePayloads.get(chatId);
  if (!payload) return null;
  if (Date.now() > payload.expiresAt) {
    activePayloads.delete(chatId);
    return null;
  }
  activePayloads.delete(chatId);
  return payload;
}

export function hasEphemeralLogin(chatId: number): boolean {
  const payload = activePayloads.get(chatId);
  if (!payload) return false;
  if (Date.now() > payload.expiresAt) {
    activePayloads.delete(chatId);
    return false;
  }
  return true;
}

export function clearEphemeralLogin(chatId: number): void {
  activePayloads.delete(chatId);
}

/** Personal-use stub: best-effort clear of references.
 *  Node.js strings are immutable; true zeroization is not possible
 *  without native addons. The GC will reclaim the strings when no
 *  references remain. */
export function zeroizePayload(payload: EphemeralLoginPayload): void {
  // No-op: strings are immutable in JS
  void payload;
}

/** Mask an email for logging (e.g. "u***@example.com"). */
export function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  const maskedLocal = local.length <= 2 ? '***' : `${local[0]}***`;
  return `${maskedLocal}@${domain}`;
}
