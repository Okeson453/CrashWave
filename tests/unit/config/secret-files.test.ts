import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolveSecret, hydrateSecretsFromFiles } from '../../../src/config/secret-files';

describe('secret-files', () => {
  const dir = '/tmp/crash-secret-test';
  const file = join(dir, 'test_secret.txt');

  beforeAll(() => {
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    try { unlinkSync(file); } catch { /* */ }
    delete process.env.TEST_SECRET;
    delete process.env.TEST_SECRET_FILE;
  });

  it('reads from FILE env path', () => {
    writeFileSync(file, 'super-secret-value\n');
    process.env.TEST_SECRET_FILE = file;
    expect(resolveSecret('TEST_SECRET')).toBe('super-secret-value');
  });

  it('falls back to env var', () => {
    process.env.TEST_SECRET = 'from-env';
    expect(resolveSecret('TEST_SECRET')).toBe('from-env');
  });

  it('hydrateSecretsFromFiles populates missing env', () => {
    writeFileSync(file, 'hydrated-db-url');
    process.env.DATABASE_URL_FILE = file;
    delete process.env.DATABASE_URL;
    hydrateSecretsFromFiles();
    expect(process.env.DATABASE_URL).toBe('hydrated-db-url');
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_FILE;
  });
});
