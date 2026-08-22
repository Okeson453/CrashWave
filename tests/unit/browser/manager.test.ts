import { BrowserManager } from '../../../src/browser/manager';
import { BrowserLaunchOptions } from '../../../src/browser/types';

// Mock playwright
jest.mock('playwright', () => ({
  chromium: {
    launchPersistentContext: jest.fn(),
  },
}));

import { chromium } from 'playwright';

describe('BrowserManager', () => {
  let manager: BrowserManager;
  const mockOptions: BrowserLaunchOptions = {
    headless: true,
    viewport: { width: 1366, height: 900 },
    userDataDir: '/tmp/test-profile',
    timeoutMs: 30000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new BrowserManager(mockOptions);
  });

  afterEach(async () => {
    try {
      await manager.close();
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('launch', () => {
    it('should launch browser with correct options', async () => {
      const mockPage = {
        setDefaultTimeout: jest.fn(),
        setDefaultNavigationTimeout: jest.fn(),
        on: jest.fn(),
        url: jest.fn().mockReturnValue('about:blank'),
        title: jest.fn().mockResolvedValue(''),
        goto: jest.fn().mockResolvedValue({}),
        evaluate: jest.fn().mockResolvedValue({}),
        screenshot: jest.fn().mockResolvedValue(Buffer.from('')),
        close: jest.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        pages: jest.fn().mockReturnValue([mockPage]),
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
        addCookies: jest.fn().mockResolvedValue(undefined),
        storageState: jest.fn().mockResolvedValue({ cookies: [], origins: [] }),
      };

      (chromium.launchPersistentContext as jest.Mock).mockResolvedValue(mockContext);

      const page = await manager.launch();

      expect(chromium.launchPersistentContext).toHaveBeenCalledWith(
        mockOptions.userDataDir,
        expect.objectContaining({
          headless: mockOptions.headless,
          viewport: mockOptions.viewport,
          timeout: mockOptions.timeoutMs,
        })
      );
      expect(page).toBe(mockPage);
      expect(manager.isLaunched()).toBe(true);
    });

    it('should reuse existing browser if already launched', async () => {
      const mockPage = {
        setDefaultTimeout: jest.fn(),
        setDefaultNavigationTimeout: jest.fn(),
        on: jest.fn(),
        url: jest.fn().mockReturnValue('about:blank'),
      };

      const mockContext = {
        pages: jest.fn().mockReturnValue([mockPage]),
        close: jest.fn().mockResolvedValue(undefined),
      };

      (chromium.launchPersistentContext as jest.Mock).mockResolvedValue(mockContext);

      await manager.launch();
      const page2 = await manager.launch();

      expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(1);
      expect(page2).toBe(mockPage);
    });

    it('should throw CriticalError on launch failure', async () => {
      (chromium.launchPersistentContext as jest.Mock).mockRejectedValue(new Error('Launch failed'));

      await expect(manager.launch()).rejects.toThrow('Browser launch failed');
      expect(manager.isLaunched()).toBe(false);
    });
  });

  describe('navigate', () => {
    it('should navigate to URL and return result', async () => {
      const mockPage = {
        setDefaultTimeout: jest.fn(),
        setDefaultNavigationTimeout: jest.fn(),
        on: jest.fn(),
        url: jest.fn().mockReturnValue('https://bc.game/crash'),
        title: jest.fn().mockResolvedValue('BC.Game Crash'),
        goto: jest.fn().mockResolvedValue({ status: () => 200 }),
        close: jest.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        pages: jest.fn().mockReturnValue([mockPage]),
        close: jest.fn().mockResolvedValue(undefined),
      };

      (chromium.launchPersistentContext as jest.Mock).mockResolvedValue(mockContext);

      await manager.launch();
      const result = await manager.navigate('https://bc.game/crash');

      expect(result.success).toBe(true);
      expect(result.url).toBe('https://bc.game/crash');
      expect(result.title).toBe('BC.Game Crash');
      expect(result.loadTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should return error result on navigation failure', async () => {
      const mockPage = {
        setDefaultTimeout: jest.fn(),
        setDefaultNavigationTimeout: jest.fn(),
        on: jest.fn(),
        url: jest.fn().mockReturnValue('about:blank'),
        title: jest.fn().mockResolvedValue(''),
        goto: jest.fn().mockRejectedValue(new Error('Navigation timeout')),
        close: jest.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        pages: jest.fn().mockReturnValue([mockPage]),
        close: jest.fn().mockResolvedValue(undefined),
      };

      (chromium.launchPersistentContext as jest.Mock).mockResolvedValue(mockContext);

      await manager.launch();
      const result = await manager.navigate('https://bc.game/crash');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Navigation timeout');
    });

    it('should throw if browser not launched', async () => {
      await expect(manager.navigate('https://bc.game')).rejects.toThrow('Browser not launched');
    });
  });

  describe('getPage', () => {
    it('should return the current page', async () => {
      const mockPage = {
        setDefaultTimeout: jest.fn(),
        setDefaultNavigationTimeout: jest.fn(),
        on: jest.fn(),
        url: jest.fn().mockReturnValue('about:blank'),
      };

      const mockContext = {
        pages: jest.fn().mockReturnValue([mockPage]),
      };

      (chromium.launchPersistentContext as jest.Mock).mockResolvedValue(mockContext);

      await manager.launch();
      expect(manager.getPage()).toBe(mockPage);
    });

    it('should throw if browser not launched', () => {
      expect(() => manager.getPage()).toThrow('Browser page not available');
    });
  });

  describe('close', () => {
    it('should close browser and reset state', async () => {
      const mockPage = {
        setDefaultTimeout: jest.fn(),
        setDefaultNavigationTimeout: jest.fn(),
        on: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        pages: jest.fn().mockReturnValue([mockPage]),
        close: jest.fn().mockResolvedValue(undefined),
      };

      (chromium.launchPersistentContext as jest.Mock).mockResolvedValue(mockContext);

      await manager.launch();
      await manager.close();

      expect(manager.isLaunched()).toBe(false);
      const state = manager.getState();
      expect(state.launched).toBe(false);
      expect(state.pageUrl).toBeNull();
    });
  });

  describe('lifecycle events', () => {
    it('should emit lifecycle events during launch', async () => {
      const mockPage = {
        setDefaultTimeout: jest.fn(),
        setDefaultNavigationTimeout: jest.fn(),
        on: jest.fn(),
        url: jest.fn().mockReturnValue('about:blank'),
      };

      const mockContext = {
        pages: jest.fn().mockReturnValue([mockPage]),
        close: jest.fn().mockResolvedValue(undefined),
      };

      (chromium.launchPersistentContext as jest.Mock).mockResolvedValue(mockContext);

      const events: Array<{ phase: string }> = [];
      manager.onLifecycle((event) => events.push(event));

      await manager.launch();

      expect(events.some((e) => e.phase === 'launching')).toBe(true);
      expect(events.some((e) => e.phase === 'launched')).toBe(true);
    });
  });

  describe('evaluate', () => {
    it('should evaluate JavaScript on the page', async () => {
      const mockPage = {
        setDefaultTimeout: jest.fn(),
        setDefaultNavigationTimeout: jest.fn(),
        on: jest.fn(),
        evaluate: jest.fn().mockResolvedValue(42),
        url: jest.fn().mockReturnValue('about:blank'),
      };

      const mockContext = {
        pages: jest.fn().mockReturnValue([mockPage]),
      };

      (chromium.launchPersistentContext as jest.Mock).mockResolvedValue(mockContext);

      await manager.launch();
      const result = await manager.evaluate(() => 42);

      expect(result).toBe(42);
    });
  });
});
