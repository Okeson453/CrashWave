/**
 * Ephemeral BC.Game login credentials — memory only, short TTL, zeroized after use.
 * Never write password to DB, Redis, env, logs, or long-lived Telegram state.
 */

export interface EphemeralLoginPayload {
  email: string;
  password: string;
  chatId: number;
  createdAt: number;
  tenantUserId?: string;
}

const DEFAULT_TTL_MS = 90_000;

const pendingByChat = new Map<number, EphemeralLoginPayload>();
const pendingByTenant = new Map<string, EphemeralLoginPayload>();

function zeroPassword(p: EphemeralLoginPayload | undefined): void {
  if (!p) return;
  (p as { password: string }).password = '';
  (p as { email: string }).email = p.email ? '***' : '';
}

export function putPendingLogin(payload: Omit<EphemeralLoginPayload, 'createdAt'>): void {
  const full: EphemeralLoginPayload = { ...payload, createdAt: Date.now() };
  pendingByChat.set(payload.chatId, full);
  if (payload.tenantUserId) {
    pendingByTenant.set(payload.tenantUserId, full);
  }
}

export function getPendingLogin(chatId: number): EphemeralLoginPayload | null {
  const p = pendingByChat.get(chatId);
  if (!p) return null;
  if (Date.now() - p.createdAt > DEFAULT_TTL_MS) {
    clearPendingLogin(chatId);
    return null;
  }
  return p;
}

export function takePendingLogin(chatId: number): EphemeralLoginPayload | null {
  const p = getPendingLogin(chatId);
  if (!p) return null;
  pendingByChat.delete(chatId);
  return p;
}

export function takeTenantLogin(tenantUserId: string): EphemeralLoginPayload | null {
  const p = pendingByTenant.get(tenantUserId);
  if (!p) return null;
  if (Date.now() - p.createdAt > DEFAULT_TTL_MS) {
    pendingByTenant.delete(tenantUserId);
    zeroPassword(p);
    return null;
  }
  pendingByTenant.delete(tenantUserId);
  pendingByChat.delete(p.chatId);
  return p;
}

export function clearPendingLogin(chatId: number): void {
  const p = pendingByChat.get(chatId);
  if (p?.tenantUserId) pendingByTenant.delete(p.tenantUserId);
  zeroPassword(p);
  pendingByChat.delete(chatId);
}

export type LoginConversationStep = 'idle' | 'awaiting_email' | 'awaiting_password' | 'authenticating';

interface ConversationState {
  step: LoginConversationStep;
  email?: string;
  chatId: number;
  tenantUserId?: string;
  startedAt: number;
}

const conversations = new Map<number, ConversationState>();

export function beginLoginConversation(chatId: number, tenantUserId?: string): void {
  conversations.set(chatId, {
    step: 'awaiting_email',
    chatId,
    tenantUserId,
    startedAt: Date.now(),
  });
}

export function getLoginConversation(chatId: number): ConversationState | null {
  const c = conversations.get(chatId);
  if (!c) return null;
  if (Date.now() - c.startedAt > 5 * 60_000) {
    endLoginConversation(chatId);
    return null;
  }
  return c;
}

export function setLoginEmail(chatId: number, email: string): boolean {
  const c = conversations.get(chatId);
  if (!c || c.step !== 'awaiting_email') return false;
  c.email = email.trim();
  c.step = 'awaiting_password';
  return true;
}

export function markAuthenticating(chatId: number): void {
  const c = conversations.get(chatId);
  if (c) c.step = 'authenticating';
}

export function endLoginConversation(chatId: number): void {
  const c = conversations.get(chatId);
  if (c) {
    c.email = undefined;
    c.step = 'idle';
  }
  conversations.delete(chatId);
  clearPendingLogin(chatId);
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const shown = local.slice(0, 1) || '*';
  return `${shown}***@${domain}`;
}
