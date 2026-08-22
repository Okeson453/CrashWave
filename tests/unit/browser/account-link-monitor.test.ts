import { AccountLinkMonitor } from '../../../src/browser/account-link-monitor';

describe('AccountLinkMonitor', () => {
  it('binds baseline once and detects profile drift', () => {
    const m = new AccountLinkMonitor();
    m.bind({
      profileId: 'profile-a',
      proxyServer: 'http://proxy:1',
      stickySessionId: 'sticky-1',
      instanceId: 'inst-1',
      startedAt: new Date().toISOString(),
    });
    expect(m.check({ profileId: 'profile-a' })).toBeNull();
    const v = m.check({ profileId: 'profile-b' });
    expect(v?.kind).toBe('profile_changed');
  });

  it('detects proxy drift', () => {
    const m = new AccountLinkMonitor();
    m.bind({
      profileId: 'p',
      proxyServer: 'http://a',
      stickySessionId: null,
      instanceId: 'i',
      startedAt: new Date().toISOString(),
    });
    const v = m.check({ proxyServer: 'http://b' });
    expect(v?.kind).toBe('proxy_changed');
  });
});
