import { TelegramGateway } from '../../../src/telegram/gateway';
import { TelegramBotConfig } from '../../../src/telegram/types';

// Mock Telegraf to avoid real network calls
jest.mock('telegraf', () => {
  return {
    Telegraf: jest.fn().mockImplementation(() => ({
      use: jest.fn().mockReturnThis(),
      catch: jest.fn().mockReturnThis(),
      launch: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn(),
      telegram: {
        sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
      },
    })),
  };
});

describe('Telegram Bot Smoke Tests', () => {
  let gateway: TelegramGateway;
  const mockConfig: TelegramBotConfig = {
    botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    allowedUserIds: [123456789],
    verbosity: 'normal',
    polling: true,
    rateLimitMessagesPerMinute: 30,
    throttlePolicies: [],
    sendRoundStart: false,
    sendRoundResult: true,
    sendHealthWarnings: true,
  };

  beforeEach(() => {
    gateway = new TelegramGateway({ config: mockConfig });
  });

  afterEach(async () => {
    await gateway.stop();
    jest.clearAllMocks();
  });

  describe('bot startup', () => {
    it('starts successfully in polling mode', async () => {
      await gateway.start();
      expect(gateway.running()).toBe(true);
    });

    it('does not start twice', async () => {
      await gateway.start();
      await gateway.start(); // Second call should be no-op
      expect(gateway.running()).toBe(true);
    });

    it('starts successfully in webhook mode', async () => {
      const webhookConfig = { ...mockConfig, webhookUrl: 'https://example.com/webhook' };
      const webhookGateway = new TelegramGateway({ config: webhookConfig });
      await webhookGateway.start();
      expect(webhookGateway.running()).toBe(true);
      await webhookGateway.stop();
    });
  });

  describe('command response latency', () => {
    it('gateway responds within acceptable time', async () => {
      await gateway.start();
      const startTime = Date.now();

      // Simulate a health check
      const health = gateway.getHealth();

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(100); // Should be very fast
      expect(health.connected).toBe(true);
    });
  });

  describe('webhook delivery', () => {
    it('sendMessage delivers to chat', async () => {
      await gateway.start();
      await gateway.sendMessage(123456789, 'Test message');

      const health = gateway.getHealth();
      expect(health.messagesSent).toBe(1);
    });

    it('tracks dropped messages when not running', async () => {
      // Don't start the gateway
      await expect(gateway.sendMessage(123456789, 'Test')).rejects.toThrow('Bot not running');
    });
  });

  describe('health status', () => {
    it('reports correct initial health', async () => {
      await gateway.start();
      const health = gateway.getHealth();

      expect(health.connected).toBe(true);
      expect(health.messagesSent).toBe(0);
      expect(health.messagesDropped).toBe(0);
      expect(health.errors).toBe(0);
      expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('graceful shutdown', () => {
    it('stops cleanly', async () => {
      await gateway.start();
      expect(gateway.running()).toBe(true);

      await gateway.stop();
      expect(gateway.running()).toBe(false);
    });

    it('handles multiple stop calls', async () => {
      await gateway.start();
      await gateway.stop();
      await gateway.stop(); // Should not throw
      expect(gateway.running()).toBe(false);
    });
  });
});
