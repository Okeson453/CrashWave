import { BrowserSession } from '../../../src/browser/session';
import { BrowserContext, Page } from 'playwright';
import { mkdir, readFile, unlink, rmdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

jest.mock('../../../src/security/crypto', () => ({
  encryptJSON: jest.fn((data) => ({
    ciphertext: Buffer.from(JSON.stringify(data)).toString('base64'),
    iv: 'test-iv',
    tag: 'test-tag',
  })),
  decryptJSON: jest.fn((encrypted) => {
    const data = Buffer.from(encrypted.ciphertext, 'base64').toString('utf-8');
    return JSON.parse(data);
  }),
}));

describe('BrowserSession', () => {
  let session: BrowserSession;
  let testDir: string;

  beforeEach(async () => {
    testDir = join('/tmp', `browser-session-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    session = new BrowserSession({ profileDirectory: testDir });
  });

  afterEach(async () => {
    try {
      const files = await readFile(testDir, { encoding: 'utf-8' }).catch(() => null);
      if (files) {
        const sessionFile = join(testDir, 'session-state.enc');
        if (existsSync(sessionFile)) {
          await unlink(sessionFile);
        }
      }
      await rmdir(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('capture', () => {
    it('should capture session state from context', async () => {
      const mockContext = {
        storageState: jest.fn().mockResolvedValue({
          cookies: [
            {
              name: 'session_token',
              value: 'abc123',
              domain: '.bc.game',
              path: '/',
              expires: Date.now() / 1000 + 3600,
              httpOnly: true,
              secure: true,
              sameSite: 'Lax' as const,
            },
          ],
          origins: [
            {
              origin: 'https://bc.game',
              localStorage: [{ name: 'user_pref', value: 'dark' }],
            },
          ],
        }),
      } as unknown as BrowserContext;

      const state = await session.capture(mockContext);

      expect(state.cookies).toHaveLength(1);
      expect(state.cookies[0].name).toBe('session_token');
      expect(state.cookies[0].value).toBe('abc123');
      expect(state.origins).toHaveLength(1);
      expect(state.origins[0].localStorage[0].name).toBe('user_pref');
      expect(state.version).toBe(1);
      expect(state.timestamp).toBeDefined();
    });

    it('should throw on capture failure', async () => {
      const mockContext = {
        storageState: jest.fn().mockRejectedValue(new Error('Storage access denied')),
      } as unknown as BrowserContext;

      await expect(session.capture(mockContext)).rejects.toThrow('Session capture failed: Storage access denied');
    });
  });

  describe('save and load', () => {
    it('should save and load session state', async () => {
      const mockContext = {
        storageState: jest.fn().mockResolvedValue({
          cookies: [
            {
              name: 'auth_token',
              value: 'xyz789',
              domain: '.bc.game',
              path: '/',
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: 'Strict' as const,
            },
          ],
          origins: [],
        }),
      } as unknown as BrowserContext;

      const captured = await session.capture(mockContext);
      await session.save(captured);

      expect(session.hasSavedSession()).toBe(true);

      const loaded = await session.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.cookies[0].name).toBe('auth_token');
      expect(loaded!.cookies[0].value).toBe('xyz789');
    });

    it('should return null when no saved session exists', async () => {
      const loaded = await session.load();
      expect(loaded).toBeNull();
    });

    it('should throw when saving without state', async () => {
      await expect(session.save()).rejects.toThrow('No session state to save');
    });
  });

  describe('restore', () => {
    it('should restore session state to context', async () => {
      const mockPage = {
        goto: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn().mockResolvedValue(undefined),
      } as unknown as Page;

      const mockContext = {
        pages: jest.fn().mockReturnValue([mockPage]),
        addCookies: jest.fn().mockResolvedValue(undefined),
        newPage: jest.fn().mockResolvedValue(mockPage),
      } as unknown as BrowserContext;

      // First save a session
      const mockStorageContext = {
        storageState: jest.fn().mockResolvedValue({
          cookies: [
            {
              name: 'restored_cookie',
              value: 'restored_value',
              domain: '.bc.game',
              path: '/',
              expires: -1,
              httpOnly: false,
              secure: false,
              sameSite: 'Lax' as const,
            },
          ],
          origins: [
            {
              origin: 'https://bc.game',
              localStorage: [{ name: 'theme', value: 'light' }],
            },
          ],
        }),
      } as unknown as BrowserContext;

      await session.capture(mockStorageContext);
      await session.save();

      // Now restore
      await session.restore(mockContext);

      expect(mockContext.addCookies).toHaveBeenCalled();
    });

    it('should handle restore when no saved session exists', async () => {
      const mockContext = {
        pages: jest.fn().mockReturnValue([]),
      } as unknown as BrowserContext;

      // Should not throw
      await expect(session.restore(mockContext)).resolves.toBeUndefined();
    });
  });

  describe('checkAuthentication', () => {
    it('should detect authenticated state', async () => {
      const mockPage = {
        evaluate: jest.fn().mockResolvedValue({
          hasUserMenu: true,
          hasBalance: true,
          hasLogout: true,
          hasLoginButton: false,
        }),
        $eval: jest.fn().mockResolvedValue('100.50 BTC'),
      } as unknown as Page;

      const result = await session.checkAuthentication(mockPage);

      expect(result.authenticated).toBe(true);
      expect(result.method).toBe('session-restore');
      expect(result.balance).toBe(100.5);
      expect(result.currency).toBe('BTC');
    });

    it('should detect unauthenticated state', async () => {
      const mockPage = {
        evaluate: jest.fn().mockResolvedValue({
          hasUserMenu: false,
          hasBalance: false,
          hasLogout: false,
          hasLoginButton: true,
        }),
        $eval: jest.fn(),
      } as unknown as Page;

      const result = await session.checkAuthentication(mockPage);

      expect(result.authenticated).toBe(false);
      expect(result.method).toBe('unknown');
    });

    it('should handle errors gracefully', async () => {
      const mockPage = {
        evaluate: jest.fn().mockRejectedValue(new Error('Page crashed')),
      } as unknown as Page;

      const result = await session.checkAuthentication(mockPage);

      expect(result.authenticated).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove saved session state', async () => {
      const mockContext = {
        storageState: jest.fn().mockResolvedValue({
          cookies: [],
          origins: [],
        }),
      } as unknown as BrowserContext;

      await session.capture(mockContext);
      await session.save();
      expect(session.hasSavedSession()).toBe(true);

      await session.clear();
      expect(session.hasSavedSession()).toBe(false);
      expect(session.getCurrentState()).toBeNull();
    });
  });

  describe('captureAndSave', () => {
    it('should capture and save in one call', async () => {
      const mockContext = {
        storageState: jest.fn().mockResolvedValue({
          cookies: [{ name: 'test', value: 'test', domain: '.bc.game', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const }],
          origins: [],
        }),
      } as unknown as BrowserContext;

      await session.captureAndSave(mockContext);
      expect(session.hasSavedSession()).toBe(true);
    });
  });
});
