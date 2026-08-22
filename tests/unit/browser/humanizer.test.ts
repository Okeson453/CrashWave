import { Humanizer } from '../../../src/browser/humanize';

describe('Humanizer', () => {
  it('constructs with defaults', () => {
    const h = new Humanizer();
    expect(h).toBeDefined();
  });

  it('click uses fill path when disabled', async () => {
    const clicks: string[] = [];
    const page = {
      locator: () => ({
        first: () => ({
          click: async () => { clicks.push('click'); },
          waitFor: async () => undefined,
          boundingBox: async () => null,
          fill: async () => undefined,
        }),
      }),
      mouse: { move: async () => undefined, click: async () => undefined },
      keyboard: { down: async () => undefined, up: async () => undefined, press: async () => undefined, type: async () => undefined },
      waitForTimeout: async () => undefined,
    } as unknown as import('playwright').Page;
    const h = new Humanizer({ enabled: false });
    await h.click(page, '.btn');
    expect(clicks).toContain('click');
  });
});
