import {
  isDryRunMode,
  isRealExecutionAllowed,
  realExecutionBlockReason,
} from '../../../src/betting/execution-mode-gate';

describe('execution-mode-gate', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('blocks real execution in dry-run', () => {
    process.env.APP_SYSTEM__MODE = 'dry-run';
    delete process.env.ALLOW_REAL_EXECUTION;
    expect(isDryRunMode()).toBe(true);
    expect(isRealExecutionAllowed()).toBe(false);
    expect(realExecutionBlockReason()).toMatch(/DRY_RUN|dry-run/i);
  });

  it('blocks live without ALLOW_REAL_EXECUTION', () => {
    process.env.APP_SYSTEM__MODE = 'live';
    delete process.env.ALLOW_REAL_EXECUTION;
    expect(isRealExecutionAllowed()).toBe(false);
    expect(realExecutionBlockReason()).toBeTruthy();
  });

  it('allows live only with mode live and ALLOW_REAL_EXECUTION', () => {
    process.env.APP_SYSTEM__MODE = 'live';
    process.env.ALLOW_REAL_EXECUTION = 'true';
    expect(isRealExecutionAllowed()).toBe(true);
    expect(realExecutionBlockReason()).toBeNull();
  });

  it('request dryRun flag always blocks', () => {
    process.env.APP_SYSTEM__MODE = 'live';
    process.env.ALLOW_REAL_EXECUTION = 'true';
    expect(isRealExecutionAllowed(true)).toBe(false);
  });

  it('allows real execution when config mode param is live and ALLOW_REAL_EXECUTION is set (env unset)', () => {
    delete process.env.APP_SYSTEM__MODE;
    delete process.env.EXECUTION_MODE;
    process.env.ALLOW_REAL_EXECUTION = 'true';
    expect(isRealExecutionAllowed(false, 'live')).toBe(true);
    expect(realExecutionBlockReason(false, 'live')).toBeNull();
  });

  it('blocks when config mode param is not live even if env is live', () => {
    process.env.APP_SYSTEM__MODE = 'live';
    process.env.ALLOW_REAL_EXECUTION = 'true';
    expect(isRealExecutionAllowed(false, 'dry-run')).toBe(false);
    expect(realExecutionBlockReason(false, 'dry-run')).toMatch(/live mode/i);
  });

  it('env dry-run flag still blocks even when config mode param is live', () => {
    process.env.APP_SYSTEM__MODE = 'dry-run';
    process.env.ALLOW_REAL_EXECUTION = 'true';
    expect(isRealExecutionAllowed(false, 'live')).toBe(false);
    expect(realExecutionBlockReason(false, 'live')).toMatch(/DRY_RUN|dry-run/i);
  });
});
