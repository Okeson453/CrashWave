import { createConfigHandlers } from '../../../../src/telegram/commands/config';
import { RouterDependencies } from '../../../../src/telegram/router';
import { OperatorContext } from '../../../../src/telegram/types';

describe('Config Commands', () => {
  let deps: RouterDependencies;

  beforeEach(() => {
    deps = {
      getConfigValue: jest.fn().mockImplementation((key: string) => {
        const values: Record<string, unknown> = {
          mode: 'dry-run',
          stakePerEntry: 700,
          cashOutTarget: 1.3,
          maxDailyEntries: 100,
        };
        return values[key];
      }),
      setConfigValue: jest.fn().mockResolvedValue(true),
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

  describe('/config show', () => {
    it('displays current configuration', async () => {
      const handlers = createConfigHandlers(deps);
      const handler = handlers.get('/config')!;
      const result = await handler(createMockContext(), ['show']);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Current Configuration');
      expect(result.message).toContain('dry-run');
      expect(result.message).toContain('700');
      expect(result.message).toContain('1.3');
      expect(result.message).toContain('100');
    });

    it('defaults to show when no subcommand', async () => {
      const handlers = createConfigHandlers(deps);
      const handler = handlers.get('/config')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Current Configuration');
    });
  });

  describe('/config set', () => {
    it('requests config change with confirmation token', async () => {
      const handlers = createConfigHandlers(deps);
      const handler = handlers.get('/config')!;
      const result = await handler(createMockContext(), ['set', 'stakePerEntry', '1000']);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Config Change Requested');
      expect(result.message).toContain('stakePerEntry');
      expect(result.message).toContain('700');
      expect(result.message).toContain('1000');
      expect(result.message).toContain('/config confirm');
    });

    it('rejects unknown config key', async () => {
      (deps.getConfigValue as jest.Mock).mockReturnValue(undefined);
      const handlers = createConfigHandlers(deps);
      const handler = handlers.get('/config')!;
      const result = await handler(createMockContext(), ['set', 'unknownKey', 'value']);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown Config Key');
    });

    it('rejects set without enough args', async () => {
      const handlers = createConfigHandlers(deps);
      const handler = handlers.get('/config')!;
      const result = await handler(createMockContext(), ['set', 'stakePerEntry']);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Usage');
    });

    it('handles multi-word values', async () => {
      const handlers = createConfigHandlers(deps);
      const handler = handlers.get('/config')!;
      const result = await handler(createMockContext(), ['set', 'mode', 'dry run']);

      expect(result.success).toBe(true);
      expect(result.message).toContain('dry run');
    });
  });

  describe('/config confirm', () => {
    it('shows usage when no token provided', async () => {
      const handlers = createConfigHandlers(deps);
      const handler = handlers.get('/config')!;
      const result = await handler(createMockContext(), ['confirm']);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Usage');
    });

    it('rejects invalid token', async () => {
      const handlers = createConfigHandlers(deps);
      const handler = handlers.get('/config')!;
      const result = await handler(createMockContext(), ['confirm', 'INVALID']);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid or Expired Token');
    });

    it('accepts valid token and applies change', async () => {
      // First, request a change to get a token
      const handlers = createConfigHandlers(deps);
      const handler = handlers.get('/config')!;
      const setResult = await handler(createMockContext(), ['set', 'stakePerEntry', '1000']);

      expect(setResult.success).toBe(true);

      // Extract token from message
      const tokenMatch = setResult.message.match(/confirm ([A-Z0-9]+)/);
      expect(tokenMatch).not.toBeNull();
      const token = tokenMatch![1];

      // Now confirm
      const confirmResult = await handler(createMockContext(), ['confirm', token]);

      expect(confirmResult.success).toBe(true);
      expect(confirmResult.message).toContain('Config Updated');
      expect(confirmResult.message).toContain('stakePerEntry');
      expect(confirmResult.message).toContain('1000');
      expect(deps.setConfigValue).toHaveBeenCalledWith('stakePerEntry', '1000');
    });

    it('rejects expired token', async () => {
      jest.useFakeTimers();
      const handlers = createConfigHandlers(deps);
      const handler = handlers.get('/config')!;

      // Request change
      const setResult = await handler(createMockContext(), ['set', 'stakePerEntry', '1000']);
      const tokenMatch = setResult.message.match(/confirm ([A-Z0-9]+)/);
      const token = tokenMatch![1];

      // Advance time past expiration (5 minutes + 1 second)
      jest.advanceTimersByTime(5 * 60 * 1000 + 1000);

      // Try to confirm
      const confirmResult = await handler(createMockContext(), ['confirm', token]);

      expect(confirmResult.success).toBe(false);
      expect(confirmResult.message).toContain('Token Expired');

      jest.useRealTimers();
    });
  });

  describe('help message', () => {
    it('shows help for unrecognized subcommand', async () => {
      const handlers = createConfigHandlers(deps);
      const handler = handlers.get('/config')!;
      const result = await handler(createMockContext(), ['unknown']);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Config Commands');
      expect(result.message).toContain('show');
      expect(result.message).toContain('set');
      expect(result.message).toContain('confirm');
    });
  });
});
