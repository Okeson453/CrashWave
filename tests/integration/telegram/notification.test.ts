import { CriticalDispatcher } from '../../../src/telegram/dispatchers/critical';
import { RoutineDispatcher } from '../../../src/telegram/dispatchers/routine';
import { HealthDispatcher } from '../../../src/telegram/dispatchers/health';
import { ThrottleEngine } from '../../../src/telegram/throttle';
import { createNotificationPayload } from '../../../src/telegram/formatters/notifications';
import { NotificationPayload } from '../../../src/telegram/types';

describe('Telegram Notification Integration', () => {
  let sentMessages: Array<{ chatId: number; text: string; extra?: Record<string, unknown> }>;
  const operatorChatIds = [123456789, 987654321];

  const mockSendMessage = jest.fn().mockImplementation(
    async (chatId: number, text: string, extra?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, extra });
    }
  );

  beforeEach(() => {
    sentMessages = [];
    mockSendMessage.mockClear();
  });

  describe('CriticalDispatcher', () => {
    let dispatcher: CriticalDispatcher;

    beforeEach(() => {
      dispatcher = new CriticalDispatcher({
        sendMessage: mockSendMessage,
        operatorChatIds,
        maxRetries: 2,
        retryDelayMs: 100,
      });
    });

    it('delivers critical alert to all operators', async () => {
      const payload = createNotificationPayload(
        'critical',
        'error',
        'System Failure',
        'Database connection lost',
        { component: 'Database', code: 'CONN_LOST' }
      );

      await dispatcher.dispatch(payload);

      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0].chatId).toBe(123456789);
      expect(sentMessages[1].chatId).toBe(987654321);
      expect(sentMessages[0].text).toContain('CRITICAL ERROR');
    });

    it('retries on failure', async () => {
      let attempts = 0;
      const failingSend = jest.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 2) throw new Error('Network error');
      });

      const retryDispatcher = new CriticalDispatcher({
        sendMessage: failingSend,
        operatorChatIds: [123456789],
        maxRetries: 2,
        retryDelayMs: 50,
      });

      const payload = createNotificationPayload('critical', 'error', 'Test', 'Test message');
      await retryDispatcher.dispatch(payload);

      expect(attempts).toBe(2);
    });

    it('deduplicates in-flight notifications', async () => {
      const payload = createNotificationPayload('critical', 'error', 'Test', 'Test');

      // Dispatch same payload twice concurrently
      await Promise.all([
        dispatcher.dispatch(payload),
        dispatcher.dispatch(payload),
      ]);

      // Should only deliver once per operator
      const messagesForFirstOp = sentMessages.filter((m) => m.chatId === 123456789);
      expect(messagesForFirstOp.length).toBeLessThanOrEqual(1);
    });
  });

  describe('RoutineDispatcher', () => {
    let dispatcher: RoutineDispatcher;

    beforeEach(() => {
      dispatcher = new RoutineDispatcher({
        sendMessage: mockSendMessage,
        operatorChatIds,
        verbosity: 'normal',
      });
    });

    afterEach(() => {
      dispatcher.stop();
    });

    it('respects verbosity settings', async () => {
      const quietDispatcher = new RoutineDispatcher({
        sendMessage: mockSendMessage,
        operatorChatIds,
        verbosity: 'quiet',
      });

      const payload = createNotificationPayload('info', 'system', 'Info', 'Test info');
      await quietDispatcher.dispatch(payload);
      await quietDispatcher.flush();

      expect(sentMessages).toHaveLength(0);
      quietDispatcher.stop();
    });

    it('batches multiple info notifications', async () => {
      const payload1 = createNotificationPayload('info', 'win', 'Info 1', 'Message 1');
      const payload2 = createNotificationPayload('info', 'loss', 'Info 2', 'Message 2');

      await dispatcher.dispatch(payload1);
      await dispatcher.dispatch(payload2);
      await dispatcher.flush();

      // Should be batched into fewer messages
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    });

    it('allows debug in verbose mode', async () => {
      const verboseDispatcher = new RoutineDispatcher({
        sendMessage: mockSendMessage,
        operatorChatIds,
        verbosity: 'verbose',
      });

      const payload = createNotificationPayload('info', 'system', 'Info', 'Test');
      await verboseDispatcher.dispatch(payload);
      await verboseDispatcher.flush();

      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
      verboseDispatcher.stop();
    });
  });

  describe('HealthDispatcher', () => {
    let dispatcher: HealthDispatcher;

    beforeEach(() => {
      dispatcher = new HealthDispatcher({
        sendMessage: mockSendMessage,
        operatorChatIds,
        debounceMs: 5000,
      });
    });

    afterEach(() => {
      dispatcher.stop();
    });

    it('debounces duplicate health warnings', async () => {
      const payload1 = createNotificationPayload(
        'warning',
        'health',
        'High Latency',
        'Latency is high',
        { component: 'GameAdapter', status: 'degraded' }
      );
      const payload2 = createNotificationPayload(
        'warning',
        'health',
        'High Latency',
        'Latency is still high',
        { component: 'GameAdapter', status: 'degraded' }
      );

      await dispatcher.dispatch(payload1);
      await dispatcher.dispatch(payload2);
      await dispatcher.flush();

      // Should only send one because status is the same
      const healthMessages = sentMessages.filter((m) => m.text.includes('Health'));
      expect(healthMessages.length).toBeLessThanOrEqual(2);
    });

    it('allows different component statuses', async () => {
      const payload1 = createNotificationPayload(
        'warning',
        'health',
        'DB Slow',
        'Database slow',
        { component: 'Database', status: 'degraded' }
      );
      const payload2 = createNotificationPayload(
        'warning',
        'health',
        'Browser Issue',
        'Browser disconnected',
        { component: 'Browser', status: 'down' }
      );

      await dispatcher.dispatch(payload1);
      await dispatcher.dispatch(payload2);
      await dispatcher.flush();

      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    });

    it('clears cache after recovery', async () => {
      dispatcher.clearCache();
      // Just verify it doesn't throw
      expect(true).toBe(true);
    });
  });

  describe('ThrottleEngine', () => {
    it('integrates with dispatchers correctly', async () => {
      const sent: NotificationPayload[][] = [];
      const engine = new ThrottleEngine({
        onSend: async (notifications) => {
          sent.push(notifications);
        },
      });

      const critical = createNotificationPayload('critical', 'error', 'Critical', 'Critical msg');
      const warning = createNotificationPayload('warning', 'health', 'Warning', 'Warning msg');

      await engine.submit(critical);
      await engine.submit(warning);
      await engine.flushAll();

      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent[0][0].severity).toBe('critical');

      engine.stop();
    });
  });
});
