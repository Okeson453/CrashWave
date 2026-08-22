import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

function getKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY;
  if (!envKey) {
    throw new Error('ENCRYPTION_KEY environment variable is required for encryption operations');
  }
  // Support both base64 and hex keys
  const key = Buffer.from(envKey, 'base64');
  if (key.length === 32) return key;
  const hexKey = Buffer.from(envKey, 'hex');
  if (hexKey.length === 32) return hexKey;
  throw new Error(`ENCRYPTION_KEY must decode to 32 bytes. Got ${key.length} (base64) or ${hexKey.length} (hex)`);
}

export interface EncryptedData {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encrypt(plaintext: string): EncryptedData {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
  ciphertext += cipher.final('base64');

  const tag = cipher.getAuthTag();

  return {
    ciphertext,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decrypt(data: EncryptedData): string {
  const key = getKey();
  const iv = Buffer.from(data.iv, 'base64');
  const tag = Buffer.from(data.tag, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let plaintext = decipher.update(data.ciphertext, 'base64', 'utf8');
  plaintext += decipher.final('utf8');

  return plaintext;
}

export function encryptJSON<T>(data: T): EncryptedData {
  return encrypt(JSON.stringify(data));
}

export function decryptJSON<T>(data: EncryptedData): T {
  return JSON.parse(decrypt(data)) as T;
}

export function hashForIdempotency(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function generateSecureToken(length = 32): string {
  return randomBytes(length).toString('hex');
}

export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
