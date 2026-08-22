import { ChallengeDetector } from '../../../src/browser/challenge-detector';

describe('ChallengeDetector', () => {
  it('raises ws anomaly on abnormal close codes', async () => {
    const page = {
      url: () => 'https://bc.game/crash',
      title: async () => 'Crash',
      locator: () => ({ count: async () => 0 }),
    } as unknown as import('playwright').Page;
    const events: unknown[] = [];
    const d = new ChallengeDetector({
      page,
      intervalMs: 60_000,
      onChallenge: (e) => events.push(e),
    });
    d.recordWsClose(1006);
    expect(events.length).toBe(1);
    expect((events[0] as { kind: string }).kind).toBe('ws_anomaly');
  });

  it('detects cloudflare selector', async () => {
    const page = {
      url: () => 'https://bc.game/crash',
      title: async () => 'Just a moment',
      locator: (sel: string) => ({
        count: async () => (sel.includes('challenge') || sel.includes('Just') ? 1 : 0),
      }),
    } as unknown as import('playwright').Page;
    const d = new ChallengeDetector({ page, intervalMs: 60_000 });
    const ev = await d.scan();
    expect(ev).not.toBeNull();
  });
});
