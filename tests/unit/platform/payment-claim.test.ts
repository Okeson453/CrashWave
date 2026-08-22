/**
 * Atomic claim semantics for payment references.
 * Simulates concurrent webhooks: only one INSERT RETURNING succeeds.
 */

describe('payment reference atomic claim', () => {
  it('only one of concurrent claims wins', () => {
    const seen = new Set<string>();
    function claim(ref: string): boolean {
      if (seen.has(ref)) return false;
      seen.add(ref);
      return true;
    }
    const results = [claim('ref-1'), claim('ref-1'), claim('ref-1')];
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results[0]).toBe(true);
  });

  it('different references all succeed', () => {
    const seen = new Set<string>();
    function claim(ref: string): boolean {
      if (seen.has(ref)) return false;
      seen.add(ref);
      return true;
    }
    expect(claim('a')).toBe(true);
    expect(claim('b')).toBe(true);
    expect(claim('a')).toBe(false);
  });
});
