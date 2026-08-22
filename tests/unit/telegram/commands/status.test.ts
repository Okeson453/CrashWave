import { createStatusHandlers } from '../../../../src/telegram/commands/status';
import { RouterDependencies } from '../../../../src/telegram/router';
import { OperatorContext } from '../../../../src/telegram/types';

describe('Status Commands', () => {
  let deps: RouterDependencies;
  let handlers: Map<string, ReturnType<typeof createStatusHandlers> extends Map<string, infer V> ? V : never>;

  beforeEach(() => {
    deps = {
      getOrchestratorState: jest.fn(),
      getLedgerSummary: jest.fn(),
      getHealthStatus: jest.fn(),
    };
    handlers = createStatusHandlers(deps);
  });

  function createMockContext(): OperatorContext {
    return {
      from: { id: 123456789, username: 'operator1', first_name: 'Test', last_name: 'User' },
      chat: { id: 123456789, type: 'private' },
      reply: jest.fn().mockResolvedValue(undefined),
      isAuthenticated: true,
      operatorId: '123456789',
    } as unknown as OperatorContext;
  }

  describe('/status', () => {
    it('returns formatted status with orchestrator data', async () => {
      (deps.getOrchestratorState as jest.Mock).mockReturnValue({
        mode: 'live',
        running: true,
        sessionId: 'sess-123',
        roundsObserved: 42,
        errors: 0,
        startedAt: new Date(Date.now() - 3600000).toISOString(),
      });

      const handler = handlers.get('/status')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('System Status');
      expect(result.message).toContain('live');
      expect(result.message).toContain('sess-123');
      expect(result.message).toContain('42');
      expect(result.parseMode).toBe('MarkdownV2');
    });

    it('handles missing orchestrator state gracefully', async () => {
      (deps.getOrchestratorState as jest.Mock).mockReturnValue(undefined);

      const handler = handlers.get('/status')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('unknown');
    });
  });

  describe('/balance', () => {
    it('returns balance when available', async () => {
      (deps.getOrchestratorState as jest.Mock).mockReturnValue({ balance: 15000.5 });

      const handler = handlers.get('/balance')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('15000.50');
    });

    it('returns no data message when balance unavailable', async () => {
      (deps.getOrchestratorState as jest.Mock).mockReturnValue({});

      const handler = handlers.get('/balance')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('No balance data');
    });
  });

  describe('/daily', () => {
    it('returns daily summary with ledger data', async () => {
      (deps.getLedgerSummary as jest.Mock).mockReturnValue({
        dailyKey: '2024-01-15',
        entriesConfirmed: 10,
        entriesAttempted: 12,
        wins: 7,
        losses: 3,
        netPnl: 350.5,
        maxDrawdown: 0.05,
      });

      const handler = handlers.get('/daily')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('2024-01-15');
      expect(result.message).toContain('10/12');
      expect(result.message).toContain('7W / 3L');
      expect(result.message).toContain('+350.50');
    });
  });

  describe('/session', () => {
    it('returns session info', async () => {
      (deps.getOrchestratorState as jest.Mock).mockReturnValue({
        sessionId: 'sess-abc',
        mode: 'dry-run',
        roundsObserved: 100,
        ticksRecorded: 5000,
        startedAt: new Date().toISOString(),
      });

      const handler = handlers.get('/session')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('sess-abc');
      expect(result.message).toContain('dry-run');
      expect(result.message).toContain('100');
      expect(result.message).toContain('5000');
    });
  });

  describe('/pnl', () => {
    it('returns P&L summary', async () => {
      (deps.getLedgerSummary as jest.Mock).mockReturnValue({
        netPnl: 1250.75,
        grossProfit: 2000,
        grossLoss: 749.25,
        hitRate: 0.65,
      });

      const handler = handlers.get('/pnl')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('+1250.75');
      expect(result.message).toContain('+2000.00');
      expect(result.message).toContain('+749.25');
      expect(result.message).toContain('65.0%');
    });
  });

  describe('/entries', () => {
    it('returns entry counts', async () => {
      (deps.getLedgerSummary as jest.Mock).mockReturnValue({
        entriesConfirmed: 15,
        entriesAttempted: 18,
        entriesFailed: 2,
        entriesReserved: 1,
      });

      const handler = handlers.get('/entries')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('15');
      expect(result.message).toContain('18');
      expect(result.message).toContain('2');
      expect(result.message).toContain('1');
    });
  });

  describe('/health', () => {
    it('returns health status with checks', async () => {
      (deps.getHealthStatus as jest.Mock).mockReturnValue({
        status: 'healthy',
        checks: [
          { name: 'Database', ok: true },
          { name: 'Browser', ok: true, message: 'Connected' },
          { name: 'Game Adapter', ok: false, message: 'Latency high' },
        ],
      });

      const handler = handlers.get('/health')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('HEALTHY');
      expect(result.message).toContain('Database');
      expect(result.message).toContain('Browser');
      expect(result.message).toContain('Game Adapter');
    });
  });

  describe('/lastround', () => {
    it('returns last round info when available', async () => {
      (deps.getOrchestratorState as jest.Mock).mockReturnValue({
        currentRoundId: 'round-999',
        lastCrashPoint: 2.45,
      });

      const handler = handlers.get('/lastround')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('round-999');
      expect(result.message).toContain('2.45x');
    });

    it('returns no data when no round info', async () => {
      (deps.getOrchestratorState as jest.Mock).mockReturnValue({});

      const handler = handlers.get('/lastround')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('No round data');
    });
  });
});
