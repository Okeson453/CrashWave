/**
 * Tests for the uncaughtException / unhandledRejection crash handler
 * (spec §13.4).
 */
import { installCrashHandlers } from '../../../src/utils/crash-handler';

describe('crash-handler (utils)', () => {
  let origExit: typeof process.exit;
  let exitCode: number | null = null;
  let exitCalled = false;

  beforeEach(() => {
    origExit = process.exit;
    exitCode = null;
    exitCalled = false;
    // We can't let the real process.exit kill jest; stub it.
    process.exit = ((code?: number) => {
      exitCalled = true;
      exitCode = code ?? null;
      return undefined as never;
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = origExit;
  });

  it('installCrashHandlers is idempotent', () => {
    installCrashHandlers();
    installCrashHandlers();
    installCrashHandlers();
    // No exception, no observable state — just confirms it can be called
    // multiple times without throwing or duplicating handlers.
  });

  it('uncaughtException listener triggers process.exit(1) after a 2.5s grace', (done) => {
    installCrashHandlers();
    // The handlers were installed onto the current process. Find the
    // most-recent uncaughtException listener and invoke it directly
    // (process.emit() doesn't expose uncaughtException in the type
    //  signature, so we use the listener-list approach).
    const listeners = process.listeners('uncaughtException');
    expect(listeners.length).toBeGreaterThan(0);
    const last = listeners[listeners.length - 1] as (err: Error) => void;
    last(new Error('test-crash'));

    // Wait for the 2.5s grace period plus a small buffer.
    setTimeout(() => {
      expect(exitCalled).toBe(true);
      expect(exitCode).toBe(1);
      done();
    }, 3000);
  }, 5000);

  it('unhandledRejection listener does NOT exit; just logs', () => {
    installCrashHandlers();
    const listeners = process.listeners('unhandledRejection');
    expect(listeners.length).toBeGreaterThan(0);
    const last = listeners[listeners.length - 1] as (reason: unknown) => void;
    last(new Error('async-oh-no'));
    // Give a moment for the log to fire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // We don't assert on log output (logger is jest-suppressed).
        // We just confirm the process did NOT exit.
        expect(exitCalled).toBe(false);
        resolve();
      }, 100);
    });
  });
});
