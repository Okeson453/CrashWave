import {
  createFingerprintProfile,
  loadOrCreateFingerprint,
  fingerprintToContextOptions,
  newProfileId,
} from '../../../src/browser/fingerprint';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('FingerprintProfile', () => {
  it('creates stable consistent profile', () => {
    const id = newProfileId();
    const fp = createFingerprintProfile(id, { timezoneId: 'America/New_York' });
    expect(fp.profileId).toBe(id);
    expect(fp.userAgent).toContain('Chrome');
    expect(fp.canvasNoiseSeed).toHaveLength(32);
    expect(fp.timezoneId).toBe('America/New_York');
  });

  it('persists and reloads same fingerprint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-'));
    const id = 'test-profile-1';
    const a = loadOrCreateFingerprint(id, dir);
    const b = loadOrCreateFingerprint(id, dir);
    expect(b.canvasNoiseSeed).toBe(a.canvasNoiseSeed);
    expect(b.userAgent).toBe(a.userAgent);
    rmSync(dir, { recursive: true, force: true });
  });

  it('context options align with fingerprint', () => {
    const fp = createFingerprintProfile('x');
    const opts = fingerprintToContextOptions(fp);
    expect(opts.userAgent).toBe(fp.userAgent);
    expect(opts.extraHTTPHeaders['sec-ch-ua']).toBe(fp.secChUa);
  });
});
