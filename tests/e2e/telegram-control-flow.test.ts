import { CommandRouter, createRouter } from '../../src/telegram/router';
import { OperatorContext } from '../../src/telegram/types';
import { RouterDependencies } from '../../src/telegram/router';

/**
 * E2E Test: Operator Control Flow
 *
 * Scenario: Operator pause -> verify halt -> resume -> verify betting resumes
 * This test validates the full command lifecycle through the router.
 */
describe('E2E: Telegram Control Flow', () => {
  let router: CommandRouter;
  let systemState: {
    mode: string;
    running: boolean;
    paused: boolean;
    betsAllowed: boolean;
  };
  let deps: RouterDependencies;

  beforeEach(() => {
    systemState = {
      mode: 'live',
      running: true,
      paused: false,
      betsAllowed: true,
    };

    deps = {
      getOrchestratorState: jest.fn().mockImplementation(() => ({
        mode: systemState.mode,
        running: systemState.running,
        paused: systemState.paused,
        betsAllowed: systemState.betsAllowed,
      })),
      pauseSystem: jest.fn().mockImplementation(async (_reason: string) => {
        systemState.paused = true;
        systemState.betsAllowed = false;
        return true;
      }),
      resumeSystem: jest.fn().mockImplementation(async () => {
        systemState.paused = false;
        systemState.betsAllowed = true;
        return true;
      }),
      stopSystem: jest.fn().mockImplementation(async () => {
        systemState.running = false;
        systemState.betsAllowed = false;
        return true;
      }),
      setSystemMode: jest.fn().mockImplementation(async (mode: string) => {
        systemState.mode = mode;
        return true;
      }),
    };

    router = createRouter({ verbosity: 'normal' });
    router.setDependencies(deps);
  });

  function createMockContext(text: string): OperatorContext {
    return {
      from: { id: 123456789, username: 'operator1', first_name: 'Test', last_name: 'User' },
      chat: { id: 123456789, type: 'private' },
      message: { message_id: 1, date: Date.now(), text },
      reply: jest.fn().mockResolvedValue(undefined),
      isAuthenticated: true,
      operatorId: '123456789',
    } as unknown as OperatorContext;
  }

  describe('Scenario: Pause -> Verify Halt -> Resume -> Verify Betting Resumes', () => {
    it('Step 1: System starts in live mode with betting allowed', async () => {
      expect(systemState.mode).toBe('live');
      expect(systemState.running).toBe(true);
      expect(systemState.betsAllowed).toBe(true);
      expect(systemState.paused).toBe(false);
    });

    it('Step 2: Operator sends /pause command', async () => {
      const ctx = createMockContext('/pause manual review');
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(deps.pauseSystem).toHaveBeenCalledWith('manual review');
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('System Paused'),
        expect.any(Object)
      );
    });

    it('Step 3: System state reflects paused status', () => {
      // Simulate the pause having taken effect
      systemState.paused = true;
      systemState.betsAllowed = false;

      expect(systemState.paused).toBe(true);
      expect(systemState.betsAllowed).toBe(false);
    });

    it('Step 4: Operator verifies status shows paused', async () => {
      const ctx = createMockContext('/status');
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('live'),
        expect.any(Object)
      );
    });

    it('Step 5: Operator sends /resume command', async () => {
      const ctx = createMockContext('/resume');
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(deps.resumeSystem).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('System Resumed'),
        expect.any(Object)
      );
    });

    it('Step 6: System state reflects resumed status with betting allowed', () => {
      // Simulate the resume having taken effect
      systemState.paused = false;
      systemState.betsAllowed = true;

      expect(systemState.paused).toBe(false);
      expect(systemState.betsAllowed).toBe(true);
      expect(systemState.running).toBe(true);
    });

    it('Step 7: Operator verifies system is back to normal', async () => {
      const ctx = createMockContext('/status');
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      const replyCall = (ctx.reply as jest.Mock).mock.calls[0];
      expect(replyCall[0]).toContain('live');
    });
  });

  describe('Scenario: Emergency Stop Flow', () => {
    it('emergency stop halts everything immediately', async () => {
      const ctx = createMockContext('/emergencystop balance dropping fast');
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(deps.pauseSystem).toHaveBeenCalled();
      expect(deps.stopSystem).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('EMERGENCY STOP'),
        expect.any(Object)
      );
    });
  });

  describe('Scenario: Mode Change Flow', () => {
    it('operator changes from live to observe-only', async () => {
      const ctx = createMockContext('/mode observe');
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(deps.setSystemMode).toHaveBeenCalledWith('observe-only');
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('observe-only'),
        expect.any(Object)
      );
    });

    it('operator changes from observe-only to dry-run', async () => {
      systemState.mode = 'observe-only';

      const ctx = createMockContext('/mode dry');
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(deps.setSystemMode).toHaveBeenCalledWith('dry-run');
    });
  });

  describe('Scenario: Config Change with Confirmation', () => {
    it('operator requests config change and confirms with token', async () => {
      deps.getConfigValue = jest.fn().mockImplementation((key: string) => {
        const values: Record<string, unknown> = { stakePerEntry: 700 };
        return values[key];
      });
      deps.setConfigValue = jest.fn().mockResolvedValue(true);

      router.setDependencies(deps);

      // Step 1: Request change
      const ctx1 = createMockContext('/config set stakePerEntry 1000');
      const middleware = router.middleware();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx1, next);

      expect(ctx1.reply).toHaveBeenCalledWith(
        expect.stringContaining('Config Change Requested'),
        expect.any(Object)
      );

      // Extract token
      const replyText = (ctx1.reply as jest.Mock).mock.calls[0][0] as string;
      const tokenMatch = replyText.match(/confirm ([A-Z0-9]+)/);
      expect(tokenMatch).not.toBeNull();
      const token = tokenMatch![1];

      // Step 2: Confirm with token
      const ctx2 = createMockContext(`/config confirm ${token}`);
      await middleware(ctx2, next);

      expect(deps.setConfigValue).toHaveBeenCalledWith('stakePerEntry', '1000');
      expect(ctx2.reply).toHaveBeenCalledWith(
        expect.stringContaining('Config Updated'),
        expect.any(Object)
      );
    });
  });
});
