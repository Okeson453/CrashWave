import { randomBytes } from 'crypto';

function generateKey(): void {
  const key = randomBytes(32);
  const base64Key = key.toString('base64');

  console.log('=== AES-256 Encryption Key ===');
  console.log('');
  console.log('Base64:');
  console.log(base64Key);
  console.log('');
  console.log('Hex:');
  console.log(key.toString('hex'));
  console.log('');
  console.log('Add the Base64 key to your .env file as ENCRYPTION_KEY=<base64-key>');
  console.log('');
  console.log('WARNING: Store this key securely. It cannot be recovered if lost.');
}

generateKey();
