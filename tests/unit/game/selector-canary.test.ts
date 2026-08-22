import { SelectorCanary, CanarySelector } from '../../../src/game/selector-canary';

function mockPage(present: Record<string, number>) {
  return {
    locator: (sel: string) => ({
      count: async () => present[sel] ?? 0,
    }),
  } as unknown as import('playwright').Page;
}

describe('SelectorCanary', () => {
  const selectors: CanarySelector[] = [
    { name: 'game', selector: '.game', criticality: 'critical' },
    { name: 'mult', selector: '.mult', criticality: 'critical' },
    { name: 'bet', selector: '.bet', criticality: 'important' },
  ];

  it('reports healthy when critical selectors present', async () => {
    const page = mockPage({ '.game': 1, '.mult': 1, '.bet': 1 });
    const canary = new SelectorCanary({ page, selectors, intervalMs: 60_000 });
    const report = await canary.runCheck();
    expect(report.healthy).toBe(true);
    expect(report.missingCritical).toEqual([]);
  });

  it('reports unhealthy when critical selector missing', async () => {
    const page = mockPage({ '.game': 1, '.mult': 0, '.bet': 1 });
    const canary = new SelectorCanary({ page, selectors, intervalMs: 60_000 });
    const report = await canary.runCheck();
    expect(report.healthy).toBe(false);
    expect(report.missingCritical).toContain('mult');
  });

  it('emits critical after consecutive failures', async () => {
    const page = mockPage({ '.game': 0, '.mult': 0 });
    const critical: unknown[] = [];
    const canary = new SelectorCanary({
      page,
      selectors,
      failureThreshold: 2,
      intervalMs: 60_000,
      onCritical: (r) => critical.push(r),
    });
    await canary.runCheck();
    expect(critical.length).toBe(0);
    await canary.runCheck();
    expect(critical.length).toBe(1);
  });

  it('assertCriticalPresent acts as pre-action gate', async () => {
    const page = mockPage({ '.game': 1, '.mult': 0 });
    const canary = new SelectorCanary({ page, selectors, intervalMs: 60_000 });
    const gate = await canary.assertCriticalPresent();
    expect(gate.ok).toBe(false);
    expect(gate.missing).toContain('mult');
  });

  it('recovers consecutive failure counter when healthy', async () => {
    let counts = { '.game': 0, '.mult': 0, '.bet': 0 };
    const page = {
      locator: (sel: string) => ({
        count: async () => (counts as Record<string, number>)[sel] ?? 0,
      }),
    } as unknown as import('playwright').Page;
    const canary = new SelectorCanary({
      page,
      selectors,
      failureThreshold: 3,
      intervalMs: 60_000,
    });
    await canary.runCheck();
    counts = { '.game': 1, '.mult': 1, '.bet': 1 };
    const report = await canary.runCheck();
    expect(report.healthy).toBe(true);
  });
});
