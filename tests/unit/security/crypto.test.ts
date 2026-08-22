import { encrypt, decrypt, encryptJSON, decryptJSON, hashForIdempotency, generateSecureToken, constantTimeCompare } from '../../../src/security/crypto';

describe('crypto', () => {
  const originalEnv = process.env.ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = Buffer.from('a'.repeat(32)).toString('base64');
  });

  afterAll(() => {
    process.env.ENCRYPTION_KEY = originalEnv;
  });

  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt plaintext', () => {
      const plaintext = 'hello world';
      const encrypted = encrypt(plaintext);
      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.tag).toBeDefined();
      expect(encrypted.ciphertext).not.toBe(plaintext);

      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertexts for same plaintext', () => {
      const plaintext = 'same text';
      const e1 = encrypt(plaintext);
      const e2 = encrypt(plaintext);
      expect(e1.ciphertext).not.toBe(e2.ciphertext);
      expect(e1.iv).not.toBe(e2.iv);
    });

    it('should fail with wrong key', () => {
      const plaintext = 'secret';
      const encrypted = encrypt(plaintext);
      process.env.ENCRYPTION_KEY = Buffer.from('b'.repeat(32)).toString('base64');
      expect(() => decrypt(encrypted)).toThrow();
      process.env.ENCRYPTION_KEY = Buffer.from('a'.repeat(32)).toString('base64');
    });
  });

  describe('encryptJSON/decryptJSON', () => {
    it('should encrypt and decrypt objects', () => {
      const data = { user: 'test', balance: 1000 };
      const encrypted = encryptJSON(data);
      const decrypted = decryptJSON<typeof data>(encrypted);
      expect(decrypted).toEqual(data);
    });
  });

  describe('hashForIdempotency', () => {
    it('should produce consistent hashes', () => {
      const h1 = hashForIdempotency('same-input');
      const h2 = hashForIdempotency('same-input');
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64); // sha256 hex
    });

    it('should produce different hashes for different inputs', () => {
      const h1 = hashForIdempotency('input-a');
      const h2 = hashForIdempotency('input-b');
      expect(h1).not.toBe(h2);
    });
  });

  describe('generateSecureToken', () => {
    it('should generate tokens of specified length', () => {
      const token = generateSecureToken(16);
      expect(token).toHaveLength(32); // hex doubles length
    });

    it('should generate unique tokens', () => {
      const t1 = generateSecureToken();
      const t2 = generateSecureToken();
      expect(t1).not.toBe(t2);
    });
  });

  describe('constantTimeCompare', () => {
    it('should return true for equal strings', () => {
      expect(constantTimeCompare('abc', 'abc')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(constantTimeCompare('abc', 'abd')).toBe(false);
    });

    it('should return false for different lengths', () => {
      expect(constantTimeCompare('abc', 'abcd')).toBe(false);
    });
  });
});
