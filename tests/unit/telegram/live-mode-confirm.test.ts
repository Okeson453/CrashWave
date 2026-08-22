import {
  createControlHandlers,
  _clearPendingLiveConfirmations,
  _pendingLiveConfirmationCount,
} from '../../../src/telegram/commands/control';
import { OperatorContext } from '../../../src/telegram/types';
import { RouterDependencies } from '../../../src/telegram/router';

function mockCtx(userId = 42): OperatorContext {
  return {
    from: { id: userId, is_bot: false, first_name: 'Op' },
    operatorId: String(userId),
    isAuthenticated: true,
  } as unknown as OperatorContext;
}

describe('Live mode multi-step confirmation', () => {
  let setSystemMode: jest.Mock;
  let deps: RouterDependencies;

  beforeEach(() => {
    _clearPendingLiveConfirmations();
    setSystemMode = jest.fn(async () => true);
    deps = {
      setSystemMode,
      getOrchestratorState: () => ({ mode: 'dry-run' }),
    } as unknown as RouterDependencies;
  });

  afterEach(() => { _clearPendingLiveConfirmations(); });

  it('does not activate live on single /mode live command', async () => {
    const handlers = createControlHandlers(deps);
    const result = await handlers.get('/mode')!(mockCtx(), ['live']);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/Confirmation token/i);
    expect(setSystemMode).not.toHaveBeenCalled();
  });

  it('activates live after valid confirm token', async () => {
    const handlers = createControlHandlers(deps);
    const handler = handlers.get('/mode')!;
    const pending = await handler(mockCtx(), ['live']);
    const tokenMatch = pending.message.match(/`([A-F0-9]{8})`/);
    expect(tokenMatch).toBeTruthy();
    const confirmed = await handler(mockCtx(), ['confirm', tokenMatch![1]]);
    expect(confirmed.success).toBe(true);
    expect(setSystemMode).toHaveBeenCalledWith('live');
  });

  it('rejects wrong token', async () => {
    const handlers = createControlHandlers(deps);
    const handler = handlers.get('/mode')!;
    await handler(mockCtx(), ['live']);
    const result = await handler(mockCtx(), ['confirm', 'DEADBEEF']);
    expect(result.success).toBe(false);
    expect(setSystemMode).not.toHaveBeenCalled();
  });

  it('rejects confirm with no pending request', async () => {
    const handlers = createControlHandlers(deps);
    const result = await handlers.get('/mode')!(mockCtx(), ['confirm', 'ABCDEF12']);
    expect(result.success).toBe(false);
  });

  it('allows non-live modes without confirmation', async () => {
    const handlers = createControlHandlers(deps);
    const result = await handlers.get('/mode')!(mockCtx(), ['dry-run']);
    expect(result.success).toBe(true);
    expect(setSystemMode).toHaveBeenCalledWith('dry-run');
  });
});
