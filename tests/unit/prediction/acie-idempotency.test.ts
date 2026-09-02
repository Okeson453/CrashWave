import { ACIEEngine } from '@/prediction/acie/engine';

describe('ACIE idempotency', () => {
  it('ignores duplicate roundId', () => {
    const eng = new ACIEEngine();
    eng.onCrash({
      roundId: 'r1',
      crashPoint: 1.5,
      timestamp: new Date().toISOString(),
    });
    const n = eng.historySize();
    const obs = eng.getOnlineState().observationCount;
    eng.onCrash({
      roundId: 'r1',
      crashPoint: 1.5,
      timestamp: new Date().toISOString(),
    });
    expect(eng.historySize()).toBe(n);
    expect(eng.getOnlineState().observationCount).toBe(obs);
  });

  it('rejects invalid crashPoint', () => {
    const eng = new ACIEEngine();
    expect(() =>
      eng.onCrash({
        roundId: 'bad',
        crashPoint: Number.NaN,
        timestamp: new Date().toISOString(),
      })
    ).toThrow();
  });

  it('evaluateNext returns finite probability after seed', () => {
    const eng = new ACIEEngine();
    eng.seedHistory(
      Array.from({ length: 30 }, (_, i) => ({
        roundId: `s-${i}`,
        crashPoint: i % 3 ? 1.5 : 1.1,
        timestamp: new Date().toISOString(),
      }))
    );
    const ev = eng.evaluateNext();
    expect(Number.isFinite(ev.psi.estimatedProbability)).toBe(true);
  });
});
