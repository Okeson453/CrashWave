import { TenantSecretVault } from '../../../src/platform/secret-vault';

describe('TenantSecretVault', () => {
  const prev = process.env.TENANT_MASTER_KEY;

  beforeAll(() => {
    process.env.TENANT_MASTER_KEY = 'test-master-key-at-least-32-chars!!';
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.TENANT_MASTER_KEY;
    else process.env.TENANT_MASTER_KEY = prev;
  });

  it('round-trips encrypt/decrypt', () => {
    const vault = new TenantSecretVault();
    const plain = 'bc-user-secret';
    const enc = vault.encrypt(plain);
    expect(enc).toContain(':');
    expect(vault.decrypt(enc)).toBe(plain);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const vault = new TenantSecretVault();
    const a = vault.encrypt('same');
    const b = vault.encrypt('same');
    expect(a).not.toBe(b);
    expect(vault.decrypt(a)).toBe('same');
    expect(vault.decrypt(b)).toBe('same');
  });
});
