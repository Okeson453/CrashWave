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
});
