import { TelegramNotifier } from '../../../src/notifications/telegram';

describe('TelegramNotifier', () => {
  it('uses injected transport on success', async () => {
    const transport = jest.fn(async () => ({ messageId: '42' }));
    const notifier = new TelegramNotifier({ botToken: 'fake', operatorChatId: '1', enabled: true, transport });
    const result = await notifier.sendMessage('hello');
    expect(result.sent).toBe(true);
    expect(result.messageId).toBe('42');
  });

  it('queues on transport failure', async () => {
    const transport = jest.fn(async () => { throw new Error('network'); });
    const notifier = new TelegramNotifier({
      botToken: 'fake', operatorChatId: '1', enabled: true, transport, maxRetries: 0, timeoutMs: 100,
    });
    const result = await notifier.sendMessage('fail');
    expect(result.sent).toBe(false);
    expect(result.queued).toBe(true);
  });

  it('does not send when disabled', async () => {
    const transport = jest.fn(async () => ({ messageId: '1' }));
    const notifier = new TelegramNotifier({ botToken: 'fake', operatorChatId: '1', enabled: false, transport });
    expect((await notifier.sendMessage('nope')).sent).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it('redacts bot tokens in messages before send', async () => {
    let captured = '';
    const transport = jest.fn(async (msg: string) => { captured = msg; return { messageId: '1' }; });
    const notifier = new TelegramNotifier({ botToken: 'fake', operatorChatId: '1', enabled: true, transport });
    await notifier.sendMessage('token bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw leaked');
    expect(captured).toContain('[REDACTED]');
  });

  it('flushQueue redelivers queued messages', async () => {
    let failOnce = true;
    const transport = jest.fn(async (_msg: string) => {
      if (failOnce) { failOnce = false; throw new Error('temp'); }
      return { messageId: 'ok' };
    });
    const notifier = new TelegramNotifier({ botToken: 'fake', operatorChatId: '1', enabled: true, transport, maxRetries: 0 });
    await notifier.sendMessage('queued');
    expect(notifier.getQueueSize()).toBe(1);
    const flush = await notifier.flushQueue();
    expect(flush.delivered).toBe(1);
  });
});
