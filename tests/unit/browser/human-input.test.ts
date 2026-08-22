import { HumanInput } from '../../../src/browser/human-input';

describe('HumanInput', () => {
  it('reports enabled flag', () => {
    const page = {
      mouse: { move: jest.fn(), down: jest.fn(), up: jest.fn() },
      keyboard: { type: jest.fn(), press: jest.fn() },
      viewportSize: () => ({ width: 1366, height: 900 }),
    } as unknown as import('playwright').Page;
    const h = new HumanInput(page, { enabled: true });
    expect(h.isEnabled()).toBe(true);
    const off = new HumanInput(page, { enabled: false });
    expect(off.isEnabled()).toBe(false);
  });
});
