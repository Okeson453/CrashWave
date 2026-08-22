import { createControlHandlers } from '../../../../src/telegram/commands/control';
import { RouterDependencies } from '../../../../src/telegram/router';
import { OperatorContext } from '../../../../src/telegram/types';

describe('Control Commands', () => {
  let deps: RouterDependencies;

  beforeEach(() => {
    deps = {
      getOrchestratorState: jest.fn(),
      pauseSystem: jest.fn().mockResolvedValue(true),
      resumeSystem: jest.fn().mockResolvedValue(true),
      stopSystem: jest.fn().mockResolvedValue(true),
      setSystemMode: jest.fn().mockResolvedValue(true),
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

  describe('/pause', () => {
    it('pauses system with default reason', async () => {
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/pause')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('System Paused');
      expect(result.message).toContain('Operator requested pause');
      expect(deps.pauseSystem).toHaveBeenCalledWith('Operator requested pause');
    });

    it('pauses system with custom reason', async () => {
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/pause')!;
      const result = await handler(createMockContext(), ['manual', 'review']);

      expect(result.success).toBe(true);
      expect(deps.pauseSystem).toHaveBeenCalledWith('manual review');
    });

    it('reports failure when pause fails', async () => {
      (deps.pauseSystem as jest.Mock).mockResolvedValue(false);
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/pause')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Pause Failed');
    });
  });

  describe('/resume', () => {
    it('resumes system successfully', async () => {
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/resume')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('System Resumed');
      expect(deps.resumeSystem).toHaveBeenCalled();
    });

    it('reports failure when resume fails', async () => {
      (deps.resumeSystem as jest.Mock).mockResolvedValue(false);
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/resume')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Resume Failed');
    });
  });

  describe('/stop', () => {
    it('stops system with default reason', async () => {
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/stop')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('System Stopped');
      expect(deps.stopSystem).toHaveBeenCalled();
    });

    it('reports failure when stop fails', async () => {
      (deps.stopSystem as jest.Mock).mockResolvedValue(false);
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/stop')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Stop Failed');
    });
  });

  describe('/emergencystop', () => {
    it('triggers emergency stop successfully', async () => {
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/emergencystop')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('EMERGENCY STOP');
      expect(deps.pauseSystem).toHaveBeenCalled();
      expect(deps.stopSystem).toHaveBeenCalled();
    });

    it('reports partial failure when emergency stop fails', async () => {
      (deps.stopSystem as jest.Mock).mockResolvedValue(false);
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/emergencystop')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(false);
      expect(result.message).toContain('PARTIALLY FAILED');
    });

    it('uses custom emergency reason', async () => {
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/emergencystop')!;
      const result = await handler(createMockContext(), ['balance', 'critical']);

      expect(result.success).toBe(true);
      expect(deps.pauseSystem).toHaveBeenCalledWith('balance critical');
    });
  });

  describe('/mode', () => {
    it('shows current mode when no args', async () => {
      (deps.getOrchestratorState as jest.Mock).mockReturnValue({ mode: 'dry-run' });
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/mode')!;
      const result = await handler(createMockContext(), []);

      expect(result.success).toBe(true);
      expect(result.message).toContain('dry-run');
      expect(result.message).toContain('Available modes');
    });

    it('requires confirmation before activating live mode', async () => {
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/mode')!;
      const result = await handler(createMockContext(), ['live']);

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/Confirmation token/i);
      expect(deps.setSystemMode).not.toHaveBeenCalled();
    });

    it('changes to dry-run mode with shorthand', async () => {
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/mode')!;
      const result = await handler(createMockContext(), ['dry']);

      expect(result.success).toBe(true);
      expect(deps.setSystemMode).toHaveBeenCalledWith('dry-run');
    });

    it('changes to observe-only mode with shorthand', async () => {
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/mode')!;
      const result = await handler(createMockContext(), ['observe']);

      expect(result.success).toBe(true);
      expect(deps.setSystemMode).toHaveBeenCalledWith('observe-only');
    });

    it('rejects invalid mode', async () => {
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/mode')!;
      const result = await handler(createMockContext(), ['invalid-mode']);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid Mode');
      expect(deps.setSystemMode).not.toHaveBeenCalled();
    });

    it('reports failure when mode change fails', async () => {
      (deps.setSystemMode as jest.Mock).mockResolvedValue(false);
      const handlers = createControlHandlers(deps);
      const handler = handlers.get('/mode')!;
      const result = await handler(createMockContext(), ['dry-run']);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Mode Change Failed');
    });
  });
});
