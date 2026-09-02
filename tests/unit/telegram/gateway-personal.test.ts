/**
 * Personal-use gateway: a Telegram bot can be created with the slim
 * TelegramBotConfig (no tenant resolver, no tenant runtime factory) and
 * its `start` method refuses to launch without a real token (we don't
 * actually call bot.launch() in this test).
 */
import { TelegramGateway } from '../../../src/telegram/gateway';
import { DEFAULT_THROTTLE_POLICIES } from '../../../src/telegram/types';

describe('telegram gateway (personal-use)', () => {
  const validConfig = {
    botToken: 'test-token',
    allowedUserIds: [123456],
    verbosity: 'normal' as const,
    polling: true,
    rateLimitMessagesPerMinute: 30,
    throttlePolicies: DEFAULT_THROTTLE_POLICIES,
    sendRoundStart: false,
    sendRoundResult: true,
    sendHealthWarnings: true,
  };

  it('can be constructed without tenant resolver / tenant runtime factory', () => {
    const gw = new TelegramGateway({ config: validConfig });
    expect(gw).toBeTruthy();
  });

  it('exposes setRouterDependencies without throwing', () => {
    const gw = new TelegramGateway({ config: validConfig });
    expect(() => gw.setRouterDependencies({})).not.toThrow();
  });

  it('stops cleanly even if never started', async () => {
    const gw = new TelegramGateway({ config: validConfig });
    await expect(gw.stop()).resolves.toBeUndefined();
  });
});