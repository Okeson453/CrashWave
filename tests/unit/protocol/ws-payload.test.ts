import {
  parseWsFrame,
  PayloadCircuitBreaker,
  TickFrameSchema,
} from '../../../src/protocol/ws-payload-schemas';

describe('parseWsFrame', () => {
  it('parses tick with multiplier key', () => {
    const r = parseWsFrame(JSON.stringify({ multiplier: 1.42, roundId: 'r1' }));
    expect(r.valid).toBe(true);
    expect(r.kind).toBe('tick');
    expect((r.data as any).multiplier).toBe(1.42);
  });

  it('parses alternate key shapes', () => {
    const r = parseWsFrame(JSON.stringify({ m: '2.5', gameId: 99, phase: 'running' }));
    expect(r.valid).toBe(true);
    expect((r.data as any).multiplier).toBe(2.5);
  });

  it('parses crash result', () => {
    const r = parseWsFrame(JSON.stringify({ crash_point: 3.21, round_id: 'x' }));
    expect(r.kind).toBe('crash');
    expect((r.data as any).crashPoint).toBe(3.21);
  });

  it('invalid json trips failure', () => {
    const b = new PayloadCircuitBreaker(3);
    parseWsFrame('not-json', b);
    parseWsFrame('not-json', b);
    parseWsFrame('not-json', b);
    expect(b.isTripped).toBe(true);
  });

  it('success resets consecutive failures', () => {
    const b = new PayloadCircuitBreaker(5);
    parseWsFrame('bad', b);
    parseWsFrame(JSON.stringify({ multiplier: 1.1 }), b);
    expect(b.isTripped).toBe(false);
  });
});

describe('TickFrameSchema', () => {
  it('accepts string multipliers', () => {
    const r = TickFrameSchema.safeParse({ point: '1.05' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.multiplier).toBe(1.05);
  });
});
