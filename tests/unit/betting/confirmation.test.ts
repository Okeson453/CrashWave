import { ConfirmationObserver } from '../../../src/betting/confirmation';
import { Page } from 'playwright';

const createMockPage = (opts: {
  domVisible?: boolean;
  wsMessages?: Array<{ timestamp: number; data: string }>;
} = {}) => {
  const mockLocator = {
    first: jest.fn().mockReturnThis(),
    isVisible: jest.fn().mockResolvedValue(opts.domVisible ?? false),
    textContent: jest.fn().mockResolvedValue('1.30x'),
    waitFor: jest.fn().mockResolvedValue(undefined),
  };

  return {
    locator: jest.fn().mockReturnValue(mockLocator),
    evaluate: jest.fn().mockImplementation(() => Promise.resolve(opts.wsMessages ?? [])),
    evaluateOnNewDocument: jest.fn().mockResolvedValue(undefined),
  } as unknown as Page;
};

describe('ConfirmationObserver', () => {
  let observer: ConfirmationObserver;
  let mockPage: Page;

  beforeEach(() => {
    mockPage = createMockPage();
    observer = new ConfirmationObserver(mockPage, {
      domPollIntervalMs: 50,
      defaultTimeoutMs: 500,
      requireAuthoritativeConfirmation: false,
    });
  });

  describe('waitForBetPlaced', () => {
    it('returns true when DOM indicator is visible', async () => {
      mockPage = createMockPage({ domVisible: true });
      observer = new ConfirmationObserver(mockPage, {
        domPollIntervalMs: 50,
        defaultTimeoutMs: 500,
      requireAuthoritativeConfirmation: false,
      });

      const result = await observer.waitForBetPlaced('round-1', 'session-1', 500);
      expect(result).toBe(true);
    });

    it('returns true when WebSocket message matches', async () => {
      mockPage = createMockPage({
        wsMessages: [
          { timestamp: Date.now(), data: '{"type":"bet_placed","roundId":"round-1"}' },
        ],
      });
      observer = new ConfirmationObserver(mockPage, {
        domPollIntervalMs: 50,
        defaultTimeoutMs: 500,
      requireAuthoritativeConfirmation: false,
      });

      const result = await observer.waitForBetPlaced('round-1', 'session-1', 500);
      expect(result).toBe(true);
    });

    it('returns false when neither DOM nor WS confirms within timeout', async () => {
      mockPage = createMockPage({ domVisible: false, wsMessages: [] });
      observer = new ConfirmationObserver(mockPage, {
        domPollIntervalMs: 50,
        defaultTimeoutMs: 200,
        requireAuthoritativeConfirmation: false,
      });

      const result = await observer.waitForBetPlaced('round-1', 'session-1', 200);
      expect(result).toBe(false);
    });
  });

  describe('waitForCashOut', () => {
    it('returns multiplier when DOM shows cash-out confirmed', async () => {
      mockPage = createMockPage({ domVisible: true });
      observer = new ConfirmationObserver(mockPage, {
        domPollIntervalMs: 50,
        defaultTimeoutMs: 500,
      requireAuthoritativeConfirmation: false,
      });

      const result = await observer.waitForCashOut('bet-1', 'round-1', 500);
      expect(result).toBe(1.30);
    });

    it('returns multiplier from WebSocket message', async () => {
      mockPage = createMockPage({
        wsMessages: [
          { timestamp: Date.now(), data: '{"type":"cashout","multiplier":1.45}' },
        ],
      });
      observer = new ConfirmationObserver(mockPage, {
        domPollIntervalMs: 50,
        defaultTimeoutMs: 500,
      requireAuthoritativeConfirmation: false,
      });

      const result = await observer.waitForCashOut('bet-1', 'round-1', 500);
      expect(result).toBe(1.45);
    });

    it('returns null when cash-out not confirmed within timeout', async () => {
      mockPage = createMockPage({ domVisible: false, wsMessages: [] });
      observer = new ConfirmationObserver(mockPage, {
        domPollIntervalMs: 50,
        defaultTimeoutMs: 200,
        requireAuthoritativeConfirmation: false,
      });

      const result = await observer.waitForCashOut('bet-1', 'round-1', 200);
      expect(result).toBeNull();
    });
  });

  describe('WebSocket listener', () => {
    it('attaches listener without error', async () => {
      await expect(observer.attachWebSocketListener()).resolves.not.toThrow();
    });

    it('clears WebSocket buffer without error', async () => {
      await expect(observer.clearWebSocketBuffer()).resolves.not.toThrow();
    });
  });
});

describe('hardened authoritative confirmation', () => {
  it('does not treat DOM as server settlement when authoritative mode is enabled', async () => {
    const page = createMockPage({ domVisible: true });
    const observer = new ConfirmationObserver(page, {
      domPollIntervalMs: 10,
      defaultTimeoutMs: 30,
      requireAuthoritativeConfirmation: true,
    });
    await expect(observer.waitForCashOut('bet-1', 'round-1', 30)).resolves.toBeNull();
  });

  it('accepts an explicit authoritative settlement reader', async () => {
    const page = createMockPage({ domVisible: true });
    const observer = new ConfirmationObserver(page, {
      domPollIntervalMs: 10,
      defaultTimeoutMs: 100,
      requireAuthoritativeConfirmation: true,
    });
    observer.setAuthoritativeCashOutReader(async () => ({
      confirmed: true,
      multiplier: 1.31,
      externalReference: 'external-bet-123',
    }));
    await expect(observer.waitForCashOut('bet-1', 'round-1', 100)).resolves.toBe(1.31);
  });
});
