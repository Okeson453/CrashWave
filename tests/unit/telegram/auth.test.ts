import { createAuthMiddleware, isAuthorized, getOperatorIdentity } from '../../../src/telegram/auth';
import { OperatorContext } from '../../../src/telegram/types';

// Minimal mock context factory
function createMockContext(overrides: Partial<OperatorContext> = {}): OperatorContext {
  return {
    from: { id: 123456789, is_bot: false, username: 'operator1', first_name: 'Test', last_name: 'User' },
    chat: { id: 123456789, type: 'private' },
    message: { message_id: 1, date: Date.now(), text: '/status' },
    reply: jest.fn().mockResolvedValue(undefined),
    isAuthenticated: false,
    operatorId: 'anonymous',
    ...overrides,
  } as unknown as OperatorContext;
}

describe('Telegram Auth Middleware', () => {
  let middleware: ReturnType<typeof createAuthMiddleware>;
  const adminUserIds = [123456789, 987654321];

  beforeEach(() => {
    middleware = createAuthMiddleware({
      adminUserIds,
      allowedUserIds: adminUserIds,
      enforcePrivateChat: true,
    });
  });

  describe('identity acceptance', () => {
    it('allows any valid user in private chat (tenant identity)', async () => {
      const ctx = createMockContext();
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(next).toHaveBeenCalled();
      expect(ctx.isAuthenticated).toBe(true);
      expect(ctx.operatorId).toBe('123456789');
      expect(ctx.isAdmin).toBe(true);
    });

    it('accepts non-admin tenant with isAdmin false', async () => {
      const ctx = createMockContext({
        from: { id: 999999999, is_bot: false, username: 'tenant', first_name: 'Ten', last_name: 'Ant' },
      });
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(next).toHaveBeenCalled();
      expect(ctx.isAuthenticated).toBe(true);
      expect(ctx.isAdmin).toBe(false);
    });
  });

  describe('private-chat enforcement', () => {
    it('rejects group chat commands', async () => {
      const ctx = createMockContext({
        chat: { id: -1001234567890, type: 'group', title: 'Test Group' },
      } as Partial<OperatorContext>);
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('private chats'),
        expect.any(Object)
      );
    });

    it('rejects supergroup chat commands', async () => {
      const ctx = createMockContext({
        chat: { id: -1001234567890, type: 'supergroup', title: 'Test Supergroup' },
      } as Partial<OperatorContext>);
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
    });

    it('allows private chat when enforcement is disabled', async () => {
      const relaxedMiddleware = createAuthMiddleware({
        adminUserIds,
        allowedUserIds: adminUserIds,
        enforcePrivateChat: false,
      });
      const ctx = createMockContext({
        chat: { id: -1001234567890, type: 'group', title: 'Test Group' },
      } as Partial<OperatorContext>);
      const next = jest.fn().mockResolvedValue(undefined);

      await relaxedMiddleware(ctx, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('spoofed ID rejection', () => {
    it('rejects negative user ID', async () => {
      const ctx = createMockContext({
        from: { id: -1, is_bot: false, username: 'spoof', first_name: 'Spoof', last_name: 'Test' },
      });
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Authentication Failed'),
        expect.any(Object)
      );
    });

    it('rejects zero user ID', async () => {
      const ctx = createMockContext({
        from: { id: 0, is_bot: false, username: 'zero', first_name: 'Zero', last_name: 'Test' },
      });
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
    });

    it('rejects non-integer user ID', async () => {
      const ctx = createMockContext({
        from: { id: 123.456, is_bot: false, username: 'float', first_name: 'Float', last_name: 'Test' },
      });
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('missing user information', () => {
    it('rejects message with no from field', async () => {
      const ctx = createMockContext({ from: undefined });
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Unable to identify'),
        expect.any(Object)
      );
    });
  });
});

describe('isAuthorized', () => {
  it('returns true for allowed user', () => {
    expect(isAuthorized(123456789, [123456789, 987654321])).toBe(true);
  });

  it('returns false for disallowed user', () => {
    expect(isAuthorized(999999999, [123456789, 987654321])).toBe(false);
  });

  it('returns false for negative ID', () => {
    expect(isAuthorized(-1, [123456789])).toBe(false);
  });

  it('returns false for zero ID', () => {
    expect(isAuthorized(0, [123456789])).toBe(false);
  });

  it('returns false for non-integer ID', () => {
    expect(isAuthorized(123.456, [123456789])).toBe(false);
  });
});

describe('getOperatorIdentity', () => {
  it('extracts operator identity correctly', () => {
    const ctx = createMockContext({
      from: { id: 123456789, is_bot: false, username: 'testuser', first_name: 'Test', last_name: 'User' },
      isAuthenticated: true,
      operatorId: '123456789',
      telegramUserId: 123456789,
      isAdmin: true,
    });

    const identity = getOperatorIdentity(ctx);

    expect(identity.operatorId).toBe('123456789');
    expect(identity.username).toBe('testuser');
    expect(identity.isAuthenticated).toBe(true);
    expect(identity.telegramUserId).toBe(123456789);
  });

  it('handles missing from field gracefully', () => {
    const ctx = createMockContext({ from: undefined, operatorId: 'unknown', isAuthenticated: false });

    const identity = getOperatorIdentity(ctx);

    expect(identity.operatorId).toBe('unknown');
    expect(identity.username).toBeUndefined();
  });
});
