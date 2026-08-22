/**
 * TenantSecretVault — AES-256-GCM encryption for BC.Game credentials.
 * Master key lives only in process env (TENANT_MASTER_KEY), never in DB.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { getPool } from '../persistence/client.js';
import { getLogger } from '../observability/logger.js';

const ALGORITHM = 'aes-256-gcm';

export interface BcGameCreds {
  username: string;
  password: string;
  totp?: string;
}

function getMasterKey(): Buffer {
  const raw = process.env.TENANT_MASTER_KEY;
  if (!raw || raw.length < 32) {
    throw new Error('TENANT_MASTER_KEY must be set and >= 32 characters');
  }
  return scryptSync(raw, 'tenant-secret-vault-v1', 32);
}

export class TenantSecretVault {
  private readonly logger = getLogger();
  private key: Buffer | null = null;

  private getKey(): Buffer {
    if (!this.key) this.key = getMasterKey();
    return this.key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv(ALGORITHM, this.getKey(), iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  decrypt(ciphertext: string): string {
    const [ivHex, authTagHex, encrypted] = ciphertext.split(':');
    if (!ivHex || !authTagHex || !encrypted) {
      throw new Error('Invalid ciphertext format');
    }
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, this.getKey(), iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  async store(userId: string, creds: BcGameCreds): Promise<void> {
    const usernameEnc = this.encrypt(creds.username);
    const passwordEnc = this.encrypt(creds.password);
    const totpEnc = creds.totp ? this.encrypt(creds.totp) : null;

    await getPool().query(
      `UPDATE users SET
         bc_game_username_encrypted = $1,
         bc_game_password_encrypted = $2,
         bc_game_2fa_secret_encrypted = $3,
         updated_at = NOW()
       WHERE id = $4`,
      [usernameEnc, passwordEnc, totpEnc, userId]
    );

    this.logger.info({ component: 'TenantSecretVault', userId }, 'Credentials encrypted and stored');
  }

  async decryptForContainer(userId: string): Promise<BcGameCreds> {
    const result = await getPool().query(
      `SELECT bc_game_username_encrypted, bc_game_password_encrypted, bc_game_2fa_secret_encrypted
       FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error(`User not found: ${userId}`);
    }

    const row = result.rows[0] as {
      bc_game_username_encrypted: string | null;
      bc_game_password_encrypted: string | null;
      bc_game_2fa_secret_encrypted: string | null;
    };

    if (!row.bc_game_username_encrypted || !row.bc_game_password_encrypted) {
      throw new Error(`Credentials not configured for user ${userId}`);
    }

    const creds: BcGameCreds = {
      username: this.decrypt(row.bc_game_username_encrypted),
      password: this.decrypt(row.bc_game_password_encrypted),
    };
    if (row.bc_game_2fa_secret_encrypted) {
      creds.totp = this.decrypt(row.bc_game_2fa_secret_encrypted);
    }
    return creds;
  }
}
