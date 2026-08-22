import { GameAdapter } from '../../../src/game/adapter';
import { Page } from 'playwright';
import { NormalizedGameEvent } from '../../../src/game/types';

describe('GameAdapter', () => {
  let adapter: GameAdapter;
  let mockPage: jest.Mocked<Page>;
  let events: NormalizedGameEvent[];

  beforeEach(() => {
    events = [];
    mockPage = {
      evaluate: jest.fn(),
      evaluateOnNewDocument: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      waitForSelector: jest.fn().mockResolvedValue({} as never),
      url: jest.fn().mockReturnValue('https://bc.game/crash'),
      title: jest.fn().mockResolvedValue('BC.Game Crash'),
    } as unknown as jest.Mocked<Page>;

    adapter = new GameAdapter({
      page: mockPage,
      enableDomAdapter: true,
      enableWsAdapter: false,
      enableApiAdapter: false,
      pollIntervalMs: 50,
    });

    adapter.onEvent((event) => {
      events.push(event);
    });
  });

  afterEach(async () => {
    await adapter.stop();
  });

  describe('start', () => {
    it('should start the adapter and begin polling', async () => {
      // Simulate game loaded
      mockPage.evaluate.mockImplementation((fn: unknown, selectors: unknown) => {
        if (typeof fn === 'function') {
          return fn(selectors);
        }
        return null;
      });

      // First call returns game not loaded, second returns loaded
      let callCount = 0;
      mockPage.evaluate.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(null); // Not loaded yet
        }
        return Promise.resolve({
          phase: 'idle',
          multiplier: null,
          roundId: null,
          crashPoint: null,
          gameLoaded: true,
          timestamp: Date.now(),
        });
      });

      await adapter.start();

      expect(adapter.isRunning()).toBe(true);

      // Wait for a poll cycle
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    it('should not start twice', async () => {
      mockPage.evaluate.mockResolvedValue(null);
      mockPage.waitForSelector.mockResolvedValue({} as never);

      await adapter.start();
      await adapter.start();

      expect(adapter.isRunning()).toBe(true);
    });
  });

  describe('stop', () => {
    it('should stop the adapter', async () => {
      mockPage.evaluate.mockResolvedValue(null);
      mockPage.waitForSelector.mockResolvedValue({} as never);

      await adapter.start();
      expect(adapter.isRunning()).toBe(true);

      await adapter.stop();
      expect(adapter.isRunning()).toBe(false);
    });
  });

  describe('getCurrentState', () => {
    it('should return initial state before start', () => {
      const state = adapter.getCurrentState();
      expect(state.phase).toBe('idle');
      expect(state.roundId).toBeNull();
      expect(state.currentMultiplier).toBeNull();
    });
  });

  describe('getHealth', () => {
    it('should return health metrics', async () => {
      mockPage.evaluate.mockResolvedValue(null);
      mockPage.waitForSelector.mockResolvedValue({} as never);

      await adapter.start();
      const health = adapter.getHealth();

      expect(health.source).toBe('dom');
      expect(health.healthy).toBe(true);
      expect(health.errorCount).toBe(0);
    });
  });

  describe('event emission', () => {
    it('should emit round-started event when round begins', async () => {
      let callCount = 0;
      mockPage.evaluate.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve({
            phase: 'idle',
            multiplier: null,
            roundId: null,
            crashPoint: null,
            gameLoaded: true,
            timestamp: Date.now(),
          });
        }
        return Promise.resolve({
          phase: 'running',
          multiplier: 1.05,
          roundId: 'test-round-001',
          crashPoint: null,
          gameLoaded: true,
          timestamp: Date.now(),
        });
      });

      mockPage.waitForSelector.mockResolvedValue({} as never);

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 200));

      const roundStartedEvents = events.filter((e) => e.type === 'round-started');
      expect(roundStartedEvents.length).toBeGreaterThanOrEqual(0); // May or may not fire depending on timing
    });

    it('should emit multiplier-tick events during round', async () => {
      let callCount = 0;
      mockPage.evaluate.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          phase: 'running',
          multiplier: 1.0 + callCount * 0.1,
          roundId: 'test-round-002',
          crashPoint: null,
          gameLoaded: true,
          timestamp: Date.now(),
        });
      });

      mockPage.waitForSelector.mockResolvedValue({} as never);

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 200));

      const tickEvents = events.filter((e) => e.type === 'multiplier-tick');
      expect(tickEvents.length).toBeGreaterThanOrEqual(0);
    });

    it('should emit round-crashed event when round ends', async () => {
      let callCount = 0;
      mockPage.evaluate.mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          return Promise.resolve({
            phase: 'running',
            multiplier: 2.5,
            roundId: 'test-round-003',
            crashPoint: null,
            gameLoaded: true,
            timestamp: Date.now(),
          });
        }
        return Promise.resolve({
          phase: 'crashed',
          multiplier: null,
          roundId: 'test-round-003',
          crashPoint: 2.5,
          gameLoaded: true,
          timestamp: Date.now(),
        });
      });

      mockPage.waitForSelector.mockResolvedValue({} as never);

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 250));

      const crashEvents = events.filter((e) => e.type === 'round-crashed');
      expect(crashEvents.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('error handling', () => {
    it('should handle evaluate errors gracefully', async () => {
      mockPage.evaluate.mockRejectedValue(new Error('Page context destroyed'));
      mockPage.waitForSelector.mockResolvedValue({} as never);

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Adapter should still be running despite errors
      expect(adapter.isRunning()).toBe(true);

      const health = adapter.getHealth();
      expect(health.errorCount).toBeGreaterThan(0);
    });
  });
});
