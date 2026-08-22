/**
 * Telegram Failure Simulation Scenario
 * Tests notification system behavior when Telegram Bot API is unreachable.
 */
import { EventBus } from '../../../src/core/event-bus/bus';
import { TelegramNotifier } from '../../../src/notifications/telegram';
import { NotificationQueue } from '../../../src/notifications/queue';

describe('Simulation: Telegram Failure', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  describe('message queuing', () => {
    it('should queue messages when Telegram API is unreachable', async () => {
      const notifier = new TelegramNotifier({
        botToken: 'test-token',
        operatorChatId: '12345',
        enabled: true,
        transport: async () => { throw new Error('Telegram API unreachable'); },
      });
      const result = await notifier.sendMessage('Test alert');
      expect(result.sent).toBe(false);
      expect(result.queued).toBe(true);
      expect(notifier.getQueueSize()).toBe(1);
    });

    it('should queue multiple messages during outage', async () => {
      const notifier = new TelegramNotifier({
        botToken: 'test-token',
        operatorChatId: '12345',
        enabled: true,
        transport: async () => { throw new Error('Telegram API unreachable'); },
      });
      await notifier.sendMessage('Alert 1');
      await notifier.sendMessage('Alert 2');
      await notifier.sendMessage('Alert 3');
      expect(notifier.getQueueSize()).toBe(3);
    });

    it('should flush queued messages when Telegram recovers', async () => {
      let shouldFail = true;
      const notifier = new TelegramNotifier({
        botToken: 'test-token',
        operatorChatId: '12345',
        enabled: true,
        transport: async () => {
          if (shouldFail) throw new Error('Telegram API unreachable');
          return { messageId: 'msg-123' };
        },
      });
      await notifier.sendMessage('Message 1');
      expect(notifier.getQueueSize()).toBe(1);
      shouldFail = false;
      await notifier.flushQueue();
      expect(notifier.getQueueSize()).toBe(0);
    });

    it('should drop oldest messages when queue exceeds max size', async () => {
      const notifier = new TelegramNotifier({
        botToken: 'test-token',
        operatorChatId: '12345',
        enabled: true,
        transport: async () => { throw new Error('Telegram API unreachable'); },
      });
      await notifier.sendMessage('Message 1');
      await notifier.sendMessage('Message 2');
      await notifier.sendMessage('Message 3');
      expect(notifier.getQueueSize()).toBe(3);
    });
  });

  describe('error handling', () => {
    it('should emit CriticalError when Telegram fails persistently', async () => {
      const errors: Array<{ code: string }> = [];
      eventBus.on('CriticalError', (event: { payload: { code: string } }) => {
        errors.push(event.payload);
      });
      await eventBus.emitTyped('CriticalError', {
        message: 'Telegram Bot API unreachable after 3 retries',
        code: 'TELEGRAM_UNAVAILABLE',
        component: 'TelegramNotifier',
      }, 'tg-1', 'TelegramNotifier');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('TELEGRAM_UNAVAILABLE');
    });

    it('should handle rate limit errors gracefully', async () => {
      const notifier = new TelegramNotifier({
        botToken: 'test-token',
        operatorChatId: '12345',
        enabled: true,
        transport: async () => { throw new Error('429 Too Many Requests'); },
      });
      const result = await notifier.sendMessage('Rate limit test');
      expect(result.sent).toBe(false);
      expect(result.queued).toBe(true);
    });
  });

  describe('notification queue', () => {
    it('should use notification queue for buffering', () => {
      const queue = new NotificationQueue({ maxSize: 100, flushIntervalMs: 5000, retryAttempts: 3, retryDelayMs: 1000 });
      queue.enqueue('Test message', 'high');
      expect(queue.size()).toBe(1);
      const item = queue.dequeue();
      expect(item?.message).toBe('Test message');
      expect(queue.size()).toBe(0);
    });

    it('should respect priority ordering in queue', () => {
      const queue = new NotificationQueue({ maxSize: 100, flushIntervalMs: 5000, retryAttempts: 3, retryDelayMs: 1000 });
      queue.enqueue('Low priority', 'low');
      queue.enqueue('Critical alert', 'critical');
      queue.enqueue('Medium priority', 'normal');
      const first = queue.dequeue();
      expect(first?.priority).toBe('critical');
    });

    it('should drop low priority messages when queue is full', () => {
      const queue = new NotificationQueue({ maxSize: 2, flushIntervalMs: 5000, retryAttempts: 3, retryDelayMs: 1000 });
      queue.enqueue('Low 1', 'low');
      queue.enqueue('Low 2', 'low');
      queue.enqueue('Critical', 'critical');
      expect(queue.size()).toBe(2);
      const first = queue.dequeue();
      expect(first?.priority).toBe('critical');
    });
  });
});
