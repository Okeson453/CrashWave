/**
 * Phase 5.1 — Binding browser-automation product policy.
 *
 * Modes:
 * - remote: control plane must use BROWSER_WORKER_URL (no local Playwright)
 * - local: Playwright allowed in-process (dev / single-box only)
 * - disabled: house-game image excludes automation entirely
 */

export type BrowserProductMode = 'remote' | 'local' | 'disabled';

export function resolveBrowserProductMode(): BrowserProductMode {
  const explicit = (process.env.BROWSER_PRODUCT_MODE || '').trim().toLowerCase();
  if (explicit === 'remote' || explicit === 'local' || explicit === 'disabled') {
    return explicit;
  }
  if (process.env.BROWSER_WORKER_URL?.trim()) return 'remote';
  if (process.env.NODE_ENV === 'production') return 'disabled';
  return 'local';
}

export function assertBrowserPolicyForLive(): void {
  const mode = resolveBrowserProductMode();
  if (mode === 'disabled') {
    throw new Error(
      'Browser automation disabled by policy (BROWSER_PRODUCT_MODE=disabled). Live placement blocked.'
    );
  }
  if (mode === 'remote' && !process.env.BROWSER_WORKER_URL?.trim()) {
    throw new Error('BROWSER_PRODUCT_MODE=remote requires BROWSER_WORKER_URL');
  }
}

export function browserPolicySnapshot(): {
  mode: BrowserProductMode;
  workerUrl: string | null;
  liveAutomationAllowed: boolean;
} {
  const mode = resolveBrowserProductMode();
  return {
    mode,
    workerUrl: process.env.BROWSER_WORKER_URL?.trim() || null,
    liveAutomationAllowed: mode === 'remote' || mode === 'local',
  };
}
