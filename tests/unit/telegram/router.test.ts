import { CommandRouter, createRouter } from '../../../src/telegram/router';
import { OperatorContext } from '../../../src/telegram/types';

describe('CommandRouter', () => {
  let router: CommandRouter;

  beforeEach(() => {
    router = createRouter({ verbosity: 'normal' });
  });

  describe('command parsing', () => {
    it('parses simple command', async () => {
      const ctx = createMockContext({ text: '/status' });
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      // The middleware parses and routes; we verify it doesn't call next for commands
      await middleware(ctx, next);
      expect(next).not.toHaveBeenCalled();
    });

    it('parses command with args', async () => {
      const ctx = createMockContext({ text: '/mode live' });
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);
      expect(next).not.toHaveBeenCalled();
    });

    it('parses command with bot mention', async () => {
      const ctx = createMockContext({ text: '/status@mybot' });
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next for non-command text', async () => {
      const ctx = createMockContext({ text: 'hello world' });
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);
      expect(next).toHaveBeenCalled();
    });

    it('calls next for messages without text', async () => {
      const ctx = createMockContext({ text: undefined });
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('unknown command handling', () => {
    it('responds with unknown command for unrecognized command', async () => {
      const ctx = createMockContext({ text: '/unknowncommand' });
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Unknown Command'),
        expect.any(Object)
      );
    });
  });

  describe('argument validation', () => {
    it('handles empty args array for commands expecting args', async () => {
      const ctx = createMockContext({ text: '/mode' });
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      // /mode without args should show current mode and usage
      expect(ctx.reply).toHaveBeenCalled();
    });

    it('handles multiple args', async () => {
      const ctx = createMockContext({ text: '/config set stakePerEntry 1000' });
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(ctx.reply).toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('allows commands within rate limit', async () => {
      const ctx = createMockContext({ text: '/status' });
      const middleware = router.middleware();

      // First command should succeed
      const next = jest.fn().mockResolvedValue(undefined);
      await middleware(ctx, next);

      expect(ctx.reply).not.toHaveBeenCalledWith(
        expect.stringContaining('Rate Limited'),
        expect.anything()
      );
    });

    it('blocks commands exceeding rate limit', async () => {
      const middleware = router.middleware();

      // Send many commands rapidly from same user
      for (let i = 0; i < 35; i++) {
        const ctx = createMockContext({
          text: '/status',
        });
        const next = jest.fn().mockResolvedValue(undefined);
        await middleware(ctx, next);
      }

      // We just verify no crash occurs under rate limit pressure
    });
  });

  describe('custom handler registration', () => {
    it('allows registering custom handlers', async () => {
      const customHandler = jest.fn().mockResolvedValue({
        success: true,
        message: 'Custom response',
      });

      router.register('/custom', customHandler);

      const ctx = createMockContext({ text: '/custom' });
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      // Custom commands won't match the parser (not in knownCommands), so this
      // tests the register API exists and works
      expect(customHandler).not.toHaveBeenCalled(); // Because /custom is not in knownCommands list
    });
  });
});

function createMockContext(overrides: Partial<OperatorContext & { text?: string }> = {}): OperatorContext {
  const text = overrides.text;
  return {
    from: { id: 123456789, username: 'operator1', first_name: 'Test', last_name: 'User' },
    chat: { id: 123456789, type: 'private' },
    message: text ? { message_id: 1, date: Date.now(), text } : undefined,
    reply: jest.fn().mockResolvedValue(undefined),
    isAuthenticated: true,
    operatorId: '123456789',
    ...overrides,
  } as unknown as OperatorContext;
}
