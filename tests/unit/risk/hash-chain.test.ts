import { createHash } from 'crypto';
import { HashChainVerifier } from '../../../src/risk/provably-fair/hash-chain';

describe('HashChainVerifier', () => {
  it('verifies seed → hash link', () => {
    const seed = 'test-server-seed-abc';
    const hash = createHash('sha256').update(seed).digest('hex');
    const v = new HashChainVerifier();
    const link = v.verifyLink({ roundId: 'r1', hash, seed });
    expect(link.verified).toBe(true);
    expect(link.crashPoint).toBeGreaterThanOrEqual(1);
  });

  it('detects mismatch', () => {
    const v = new HashChainVerifier(undefined, 5);
    const link = v.verifyLink({
      roundId: 'r1',
      hash: 'deadbeef',
      seed: 'something-else',
    });
    expect(link.verified).toBe(false);
  });

  it('throws after max consecutive failures', () => {
    const v = new HashChainVerifier(undefined, 2);
    v.verifyLink({ roundId: '1', hash: 'aa', seed: 'x' });
    expect(() => v.verifyLink({ roundId: '2', hash: 'bb', seed: 'y' })).toThrow(
      /PROVABLY_FAIR_BREAK/
    );
  });
});
