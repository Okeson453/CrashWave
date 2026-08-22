import { SessionRotator } from '../../../src/browser/session-rotator';

describe('SessionRotator', () => {
  it('starts Cold and transitions', () => {
    const r = new SessionRotator({ maxAgeHours: 1, maxContinuousActiveMinutes: 1 });
    expect(r.getState()).toBe('Cold');
    r.transition('Warming');
    r.transition('Authenticated');
    r.transition('Active');
    expect(r.canAcceptEntries()).toBe(true);
  });

  it('quarantines on challenge', () => {
    const r = new SessionRotator({ quarantineOnChallenge: true });
    r.transition('Active');
    r.onChallenge({
      kind: 'cloudflare',
      detail: 'test',
      detectedAt: new Date().toISOString(),
      url: 'https://example.com',
    });
    expect(r.getState()).toBe('Quarantined');
    expect(r.canAcceptEntries()).toBe(false);
    expect(r.getSnapshot().lastQuarantineReason).toMatch(/cloudflare/);
  });

  it('soft trigger moves to Cooling', () => {
    const r = new SessionRotator();
    r.transition('Active');
    r.softTrigger('latency');
    expect(r.getState()).toBe('Cooling');
  });
});
