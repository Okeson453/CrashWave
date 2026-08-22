import { ReauthProtocol } from '../../../src/browser/reauth-protocol';

describe('ReauthProtocol', () => {
  it('enters awaiting_operator on request', async () => {
    const session = {
      checkAuthentication: async () => ({ authenticated: false }),
      saveSession: async () => undefined,
      captureAndSave: async () => undefined,
    } as any;
    const p = new ReauthProtocol(session);
    let paused = false;
    p.setHooks({ onPause: async () => { paused = true; } });
    await p.requestReauth('cookie expired');
    expect(p.isAwaitingOperator()).toBe(true);
    expect(paused).toBe(true);
    expect(p.getStatus().reason).toBe('cookie expired');
  });

  it('complete fails when still unauthenticated', async () => {
    const session = {
      checkAuthentication: async () => ({ authenticated: false }),
      saveSession: async () => undefined,
      captureAndSave: async () => undefined,
    } as any;
    const p = new ReauthProtocol(session);
    await p.requestReauth('test');
    const r = await p.completeReauth({} as any);
    expect(r.ok).toBe(false);
    expect(p.getStatus().state).toBe('failed');
  });

  it('complete succeeds and resumes when authenticated', async () => {
    const session = {
      checkAuthentication: async () => ({ authenticated: true }),
      saveSession: async () => undefined,
      captureAndSave: async () => undefined,
    } as any;
    const p = new ReauthProtocol(session);
    let resumed = false;
    p.setHooks({ onResume: async () => { resumed = true; } });
    await p.requestReauth('test');
    const r = await p.completeReauth({} as any);
    expect(r.ok).toBe(true);
    expect(resumed).toBe(true);
    expect(p.getStatus().state).toBe('resolved');
  });
});
