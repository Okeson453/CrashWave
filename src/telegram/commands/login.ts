/**
 * Telegram Operator Interface — Login (live mode only)
 *
 *   /login         — start BC.Game email/password conversation
 *   /login_cancel  — abort the active login conversation
 *
 * In personal-use:
 *   - dry-run / observe-only: `/login` is not required.
 *   - live:                   `/login` triggers the browser to log into
 *                             BC.Game; the password is consumed and never
 *                             stored, and the resulting session cookie is
 *                             encrypted with ENCRYPTION_KEY and persisted
 *                             to ./secrets/browser-profile/.
 *
 * The actual `loginWithCredentials` is invoked through RouterDependencies,
 * injected from the composition. The conversation state is kept in
 * process memory (single-process, single-operator).
 */
import { CommandHandler, CommandResult, OperatorContext } from '../types';
import { RouterDependencies } from '../router';

interface PendingLogin {
  chatId: number;
  step: 'email' | 'password';
  email?: string;
  createdAt: number;
}

const pending = new Map<number, PendingLogin>();

function isWaitingForReply(chatId: number, ctx: OperatorContext): boolean {
  const p = pending.get(chatId);
  if (!p) return false;
  // Only intercept plain-text messages (not commands) in the same chat.
  const msg = ctx.message;
  const text = msg && 'text' in msg ? (msg as { text: string }).text : '';
  if (!text || text.startsWith('/')) return false;
  return true;
}

export function createLoginHandlers(_deps: RouterDependencies): Map<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();
  const reply = (success: boolean, message: string): CommandResult => ({
    success,
    message,
    parseMode: 'Markdown',
  });

  handlers.set('/login', async (ctx: OperatorContext): Promise<CommandResult> => {
    const chatId = ctx.chat?.id;
    if (!chatId) return reply(false, 'No chat id; cannot start login conversation.');

    pending.set(chatId, { chatId, step: 'email', createdAt: Date.now() });
    // Plain text. The previous Markdown version (`*email*`) was rejected by
    // Telegram and stripped by the parse-failure fallback, so the operator
    // saw inconsistent formatting. Plain text is simpler and reliable.
    return reply(true, 'Send your BC.Game email (next message).\n\nSend /login_cancel to abort.');
  });

  handlers.set('/login_cancel', async (ctx: OperatorContext): Promise<CommandResult> => {
    const chatId = ctx.chat?.id;
    if (chatId) pending.delete(chatId);
    return reply(true, 'Login conversation cancelled.');
  });

  return handlers;
}

/**
 * Intercept a non-command text message and route it through the
 * login conversation state machine. Returns `true` if the message
 * was consumed.
 */
export async function handleLoginConversationText(
  ctx: OperatorContext,
  text: string,
  deps: RouterDependencies
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;
  const p = pending.get(chatId);
  if (!p) return false;
  if (!isWaitingForReply(chatId, ctx)) return false;

  if (p.step === 'email') {
    pending.set(chatId, { ...p, step: 'password', email: text.trim(), createdAt: Date.now() });
    // Plain text — the previous Markdown version caused "Internal Error" when
    // Telegram rejected parse_mode on `*password*`; the conversation interceptor
    // has no Markdown fallback (the global catch handler is too coarse).
    await ctx.reply('Now send your BC.Game password (next message).\n\nSend /login_cancel to abort.');
    return true;
  }

  // step === 'password'
  const email = p.email;
  pending.delete(chatId);
  if (!email) {
    await ctx.reply('Login state lost; please /login again.');
    return true;
  }
  if (!deps.loginWithCredentials) {
    await ctx.reply('Login handler is not injected. Restart the process and try /login again.');
    return true;
  }
  await ctx.reply('Logging in…');
  try {
    const result = await deps.loginWithCredentials(email, text);
    if (result.ok && result.authenticated) {
      await ctx.reply(
        [
          '✅ Logged in',
          `email: ${result.maskedEmail ?? '—'}`,
          `region blocked: ${result.regionBlocked ? 'yes' : 'no'}`,
          `game loaded: ${result.gameLoaded ? 'yes' : 'no'}`,
          `observing: ${result.observing ? 'yes' : 'no'}`,
        ].join('\n')
      );
    } else {
      await ctx.reply(`❌ Login failed: ${result.detail ?? 'unknown error'}`);
    }
  } catch (err) {
    await ctx.reply(`❌ Login error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}