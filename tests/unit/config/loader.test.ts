import { loadConfig, loadAndValidateConfig } from '../../../src/config/loader';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

describe('loadConfig', () => {
  const testDir = join(process.cwd(), 'tmp-test-config');
  const testConfigPath = join(testDir, 'test-config.yaml');

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load config from YAML file', () => {
    const yaml = `
system:
  mode: live
  serviceName: test-service
`;
    writeFileSync(testConfigPath, yaml);
    const config = loadConfig(testConfigPath);
    expect((config as Record<string, unknown>).system).toBeDefined();
    expect((config as Record<string, unknown>).system).toMatchObject({
      mode: 'live',
      serviceName: 'test-service',
    });
  });

  it('should merge with defaults', () => {
    const yaml = `
system:
  mode: observe-only
`;
    writeFileSync(testConfigPath, yaml);
    const config = loadConfig(testConfigPath);
    const betting = (config as Record<string, unknown>).betting as Record<string, unknown>;
    expect(betting.stakePerEntry).toBe(700);
    expect(betting.cashOutTarget).toBe(1.30);
  });

  it('should handle missing file gracefully', () => {
    const config = loadConfig(join(testDir, 'nonexistent.yaml'));
    expect(config).toBeDefined();
    const betting = (config as Record<string, unknown>).betting as Record<string, unknown>;
    expect(betting.stakePerEntry).toBe(700);
  });
});

describe('loadAndValidateConfig', () => {
  it('should validate and return config', () => {
    const config = loadAndValidateConfig();
    expect(config).toBeDefined();
    expect(config.system.mode).toBeDefined();
    expect(config.betting.stakePerEntry).toBe(700);
  });

  it('should throw on invalid config', () => {
    const badPath = join(process.cwd(), 'tmp-test-config', 'bad-config.yaml');
    mkdirSync(join(process.cwd(), 'tmp-test-config'), { recursive: true });
    writeFileSync(badPath, 'system:\n  mode: invalid-mode');
    expect(() => loadAndValidateConfig(badPath)).toThrow('Configuration validation failed');
  });
});
