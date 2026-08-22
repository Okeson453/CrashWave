import { createAnalyticsHandlers } from '../../../../src/telegram/commands/analytics';
import { RouterDependencies } from '../../../../src/telegram/router';
import { OperatorContext } from '../../../../src/telegram/types';

describe('Analytics Commands', () => {
  let deps: RouterDependencies;

  beforeEach(() => {
    deps = {
      getLedgerSummary: jest.fn().mockReturnValue({
        dailyKey: '2024-01-15',
        entriesConfirmed: 10,
        entriesAttempted: 12,
        wins: 7,
        losses: 3,
        netPnl: 350.5,
        grossProfit: 500,
        grossLoss: 149.5,
        hitRate: 0.7,
        maxDrawdown: 0.05,
        currentDrawdown: 0.02,
        peakPnl: 400,
        expectedValue: 35.05,
        currentStreak: 2,
        currentStreakType: 'win',
        totalBets: 10,
        balanceStart: 10000,
        balanceEnd: 10350.5,
        cashOutSuccessRate: 0.95,
      }),
    };
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

  describe('/analytics summary', () => {
    it('returns full performance summary', async () => {
      const handlers = createAnalyticsHandlers(deps);
      const handler = handlers.get('/analytics')!;
      const result = await handler(createMockContext(), ['summary']);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Performance Summary');
      expect(result.message).toContain('10');
      expect(result.message).toContain('7W / 3L');
      expect(result.message).toContain('70.0%');
      expect(result.message).toContain('+350.50');
      expect(result.message).toContain('2 win');
    });

    it('defaults to summary when no subcommand', async () => {
      const handlers = createAnalyticsHandlers(deps);
      const handler = handlers.get('/analytics')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Performance Summary');
    });
  });

  describe('/analytics today', () => {
    it('returns today\'s performance', async () => {
      const handlers = createAnalyticsHandlers(deps);
      const handler = handlers.get('/analytics')!;
      const result = await handler(createMockContext(), ['today']);

      expect(result.success).toBe(true);
      expect(result.message).toContain('2024-01-15');
      expect(result.message).toContain('10');
      expect(result.message).toContain('7W / 3L');
      expect(result.message).toContain('+350.50');
      expect(result.message).toContain('95.0%');
    });
  });

  describe('/analytics drawdown', () => {
    it('returns drawdown analysis', async () => {
      const handlers = createAnalyticsHandlers(deps);
      const handler = handlers.get('/analytics')!;
      const result = await handler(createMockContext(), ['drawdown']);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Drawdown Analysis');
      expect(result.message).toContain('5.00%');
      expect(result.message).toContain('2.00%');
      expect(result.message).toContain('+400.00');
      expect(result.message).toContain('+350.50');
    });

    it('warns when drawdown near max', async () => {
      (deps.getLedgerSummary as jest.Mock).mockReturnValue({
        maxDrawdown: 0.1,
        currentDrawdown: 0.09,
        peakPnl: 1000,
        netPnl: 100,
      });

      const handlers = createAnalyticsHandlers(deps);
      const handler = handlers.get('/analytics')!;
      const result = await handler(createMockContext(), ['drawdown']);

      expect(result.success).toBe(true);
      expect(result.message).toContain('near historical maximum');
    });
  });

  describe('/analytics <window>', () => {
    it('accepts day window', async () => {
      const handlers = createAnalyticsHandlers(deps);
      const handler = handlers.get('/analytics')!;
      const result = await handler(createMockContext(), ['7d']);

      expect(result.success).toBe(true);
      expect(result.message).toContain('7 days');
    });

    it('accepts hour window', async () => {
      const handlers = createAnalyticsHandlers(deps);
      const handler = handlers.get('/analytics')!;
      const result = await handler(createMockContext(), ['24h']);

      expect(result.success).toBe(true);
      expect(result.message).toContain('24 hours');
    });

    it('accepts week window', async () => {
      const handlers = createAnalyticsHandlers(deps);
      const handler = handlers.get('/analytics')!;
      const result = await handler(createMockContext(), ['1w']);

      expect(result.success).toBe(true);
      expect(result.message).toContain('1 weeks');
    });
  });

  describe('help message', () => {
    it('shows help for invalid input', async () => {
      const handlers = createAnalyticsHandlers(deps);
      const handler = handlers.get('/analytics')!;
      const result = await handler(createMockContext(), ['invalid']);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Analytics Commands');
      expect(result.message).toContain('summary');
      expect(result.message).toContain('today');
      expect(result.message).toContain('drawdown');
    });
  });
});
