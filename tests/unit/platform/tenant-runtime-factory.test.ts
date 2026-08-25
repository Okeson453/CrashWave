/**
 * TenantRuntimeFactory — share-primary and getOrCreate behavior.
 */

import { TenantRuntimeFactory } from '../../../src/platform/tenant-runtime-factory';
import { TenantRuntime } from '../../../src/platform/tenant-runtime';

function mockSupervisor() {
  return {
    loginWithCredentials: jest.fn(async () => ({
      ok: true,
      authenticated: true,
      gameLoaded: true,
      observing: false,
      maskedEmail: 'a***@x.com',
    })),
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    getState: jest.fn(() => ({
      phase: 'observing',
      sessionId: 's1',
      browserLaunched: true,
      authenticated: true,
      gameLoaded: true,
      observing: true,
      errorCount: 0,
      consecutiveErrors: 0,
      startedAt: new Date().toISOString(),
    })),
    getOrchestratorState: jest.fn(() => ({
      mode: 'observe-only',
      running: true,
      sessionId: 's1',
      currentRoundId: null,
      roundsObserved: 3,
      ticksRecorded: 10,
      errors: 0,
      startedAt: new Date().toISOString(),
      phase: 'observing',
      authenticated: true,
      gameLoaded: true,
      observing: true,
    })),
  } as any;
}

describe('TenantRuntimeFactory', () => {
  it('registers primary and returns it via getOrCreate for other tenant ids when sharing', async () => {
    const factory = new TenantRuntimeFactory({ sharePrimary: true });
    const supervisor = mockSupervisor();
    const primary = TenantRuntimeFactory.wrapSupervisor('engine-primary', supervisor);
    factory.registerPrimary(primary);

    const a = await factory.getOrCreate('tenant-aaa');
    const b = await factory.getOrCreate('tenant-bbb');
    expect(a).toBe(primary);
    expect(b).toBe(primary);
    expect(factory.getPrimary()).toBe(primary);
  });

  it('authenticate goes through SessionSupervisor.loginWithCredentials', async () => {
    const factory = new TenantRuntimeFactory({ sharePrimary: true });
    const supervisor = mockSupervisor();
    factory.registerPrimary(TenantRuntimeFactory.wrapSupervisor('p', supervisor));

    const rt = await factory.getOrCreate('any-tenant');
    const result = await rt.authenticate({ email: 'u@x.com', password: 'secret' });
    expect(result.ok).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(supervisor.loginWithCredentials).toHaveBeenCalledWith('u@x.com', 'secret');
  });

  it('throws when isolate mode and no createFn / primary mapping', async () => {
    const factory = new TenantRuntimeFactory({ sharePrimary: false });
    await expect(factory.getOrCreate('missing')).rejects.toThrow(/supervisor not registered/);
  });

  it('getStatus aggregates session + orchestrator', async () => {
    const supervisor = mockSupervisor();
    const rt = new TenantRuntime('t1', supervisor, null);
    const status = rt.getStatus();
    expect(status.tenantId).toBe('t1');
    expect(status.orchestrator.running).toBe(true);
    expect(status.session.phase).toBe('observing');
  });
});
