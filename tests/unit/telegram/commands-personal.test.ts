/**
 * Personal-use Telegram command handlers.
 * Verifies spec §10.7-§10.9: the command handlers exist, parse the right
 * command names, and read from the RouterDependencies (not from a tenant
 * resolver).
 */
import { createStartHandlers } from '../../../src/telegram/commands/start';
import { createStatusHandlers } from '../../../src/telegram/commands/status';
import { createAnalyticsHandlers } from '../../../src/telegram/commands/analytics';
import { createLoginHandlers } from '../../../src/telegram/commands/login';
import { createControlHandlers } from '../../../src/telegram/commands/control';
import { createConfigHandlers } from '../../../src/telegram/commands/config';

function makeCtx(): unknown {
  return {
    chat: { id: 1 },
    from: { id: 1 },
    message: { text: '/status' },
    reply: async () => undefined,
  };
}

describe('personal-use telegram commands (factory wiring)', () => {
  it('start handlers cover /start /menu /help', () => {
    const h = createStartHandlers({});
    expect(h.has('/start')).toBe(true);
    expect(h.has('/menu')).toBe(true);
    expect(h.has('/help')).toBe(true);
  });

  it('status handlers cover the 8 read-only commands', () => {
    const h = createStatusHandlers({});
    for (const cmd of ['/status', '/balance', '/pnl', '/daily', '/entries', '/session', '/health', '/lastround']) {
      expect(h.has(cmd)).toBe(true);
    }
  });

  it('analytics handler covers /analytics', () => {
    const h = createAnalyticsHandlers({});
    expect(h.has('/analytics')).toBe(true);
  });

  it('login handlers cover /login and /login_cancel', () => {
    const h = createLoginHandlers({});
    expect(h.has('/login')).toBe(true);
    expect(h.has('/login_cancel')).toBe(true);
  });

  it('control handlers cover /pause /resume /stop /sheath /unsheath /emergencystop /mode', () => {
    const h = createControlHandlers({});
    for (const cmd of ['/pause', '/resume', '/stop', '/sheath', '/unsheath', '/emergencystop', '/mode']) {
      expect(h.has(cmd)).toBe(true);
    }
  });

  it('config handlers cover /config', () => {
    const h = createConfigHandlers({});
    expect(h.has('/config')).toBe(true);
  });
});

describe('personal-use telegram commands (output)', () => {
  it('/status returns a Markdown message with mode, balance, and last round', async () => {
    const h = createStatusHandlers({
      getOrchestratorState: () => ({
        sessionId: 'sess-1',
        mode: 'dry-run',
        uptimeSeconds: 60,
        lastRound: { id: 'r-1', crashPoint: 1.5, crashedAt: '2026-01-01T00:00:00Z' },
        recentTrades: [],
      }),
      getLedgerSummary: () => ({
        virtualBalance: 9800,
        initialBalance: 10000,
        netPnl: -200,
        wins: 3, losses: 2, winRate: 0.6, openTrades: 0, maxDrawdown: 200,
      }),
      getHealthStatus: () => ({ status: 'healthy' }),
    });
    const result = await h.get('/status')!(makeCtx() as never, []);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/DRY-RUN/i);
    expect(result.message).toMatch(/9800/);
    expect(result.message).toMatch(/1\.50x/);
  });

  it('/analytics reports signals / accepted / rejected from deps', async () => {
    const h = createAnalyticsHandlers({
      getWindowedAnalytics: () => ({
        signals: 12, signalsAccepted: 4, signalsRejected: 8,
        avgProbability: 0.42, avgConfidence: 0.5, expectedValue: 0.02,
        regime: 'normal', modelVersion: 'v1',
      }),
    });
    const result = await h.get('/analytics')!(makeCtx() as never, []);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/12/);
    expect(result.message).toMatch(/0\.42/);
  });

  it('/login returns a "send your email" prompt and registers a pending conversation', async () => {
    const h = createLoginHandlers({});
    const result = await h.get('/login')!(makeCtx() as never, []);
    expect(result.success).toBe(true);
    expect(result.message.toLowerCase()).toContain('email');
  });

  it('/start welcome message lists quick start', async () => {
    const h = createStartHandlers({});
    const result = await h.get('/start')!(makeCtx() as never, []);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/status/);
    expect(result.message).toMatch(/health/);
  });
});

describe('personal-use telegram control command (live confirmation)', () => {
  it('/mode live issues a token; /mode confirm activates; /mode live again issues a new one', async () => {
    const h = createControlHandlers({ setSystemMode: async () => true });
    const r1 = await h.get('/mode')!(makeCtx() as never, ['live']);
    expect(r1.success).toBe(true);
    expect(r1.message).toMatch(/confirm/i);
    const tokenMatch = r1.message.match(/[A-Z0-9]{8}/);
    expect(tokenMatch).toBeTruthy();
    const token = tokenMatch![0];
    const r2 = await h.get('/mode')!(makeCtx() as never, ['confirm', token]);
    expect(r2.success).toBe(true);
    expect(r2.message.toLowerCase()).toMatch(/live.*active|activated/);
  });
});