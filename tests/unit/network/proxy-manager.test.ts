import { ProxyManager } from '../../../src/network/proxy-manager';

describe('ProxyManager', () => {
  it('returns null when disabled', async () => {
    const pm = new ProxyManager({
      enabled: false,
      sticky: true,
      rotationMode: 'never',
      provider: 'generic',
    });
    expect(await pm.resolve()).toBeNull();
  });

  it('resolves sticky proxy', async () => {
    const pm = new ProxyManager({
      enabled: true,
      server: 'http://proxy.example:8080',
      username: 'user',
      password: 'pass',
      sticky: true,
      rotationMode: 'never',
      provider: 'generic',
    });
    const a = await pm.resolve();
    const b = await pm.resolve();
    expect(a?.server).toBe('http://proxy.example:8080');
    expect(b?.stickySessionId).toBe(a?.stickySessionId);
  });

  it('injects session for provider sticky username', async () => {
    const pm = new ProxyManager({
      enabled: true,
      server: 'http://proxy.example:8080',
      username: 'myuser',
      sticky: true,
      rotationMode: 'never',
      provider: 'brightdata',
    });
    const r = await pm.resolve();
    expect(r?.username).toContain('-session-');
  });
});
