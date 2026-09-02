/**
 * Hardened Playwright/Chromium launch configuration.
 * Removes automation signals and aligns flags with real Chrome behavior.
 */

export interface LaunchHardeningOptions {
  headless?: boolean;
  windowWidth?: number;
  windowHeight?: number;
  lang?: string;
  /** Prefer real GPU when available (better WebGL consistency). */
  useRealGpu?: boolean;
  /** Extra args appended last */
  extraArgs?: string[];
}

/**
 * Production Chromium flags — keep minimal for version stability.
 * Full stealth set only when STEALTH_FULL_FLAGS=1.
 * Never include --enable-automation.
 */
export const HARDENED_LAUNCH_ARGS_MINIMAL: readonly string[] = Object.freeze([
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
]);

/** Extended flags (opt-in via STEALTH_FULL_FLAGS=1) */
export const HARDENED_LAUNCH_ARGS_FULL: readonly string[] = Object.freeze([
  ...HARDENED_LAUNCH_ARGS_MINIMAL,
  '--disable-features=IsolateOrigins,site-per-process,AutomationControlled,TranslateUI,IdleDetection,AudioServiceOutOfProcess',
  '--disable-site-isolation-trials',
  '--disable-infobars',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--disable-domain-reliability',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--metrics-recording-only',
  '--password-store=basic',
  '--use-mock-keychain',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--disable-component-update',
]);

/** Default export: minimal unless STEALTH_FULL_FLAGS is set at process start */
export const HARDENED_LAUNCH_ARGS: readonly string[] = HARDENED_LAUNCH_ARGS_MINIMAL;

function resolveHardenedBaseArgs(): readonly string[] {
  return process.env.STEALTH_FULL_FLAGS === '1' || process.env.STEALTH_FULL_FLAGS === 'true'
    ? HARDENED_LAUNCH_ARGS_FULL
    : HARDENED_LAUNCH_ARGS_MINIMAL;
}

const AUTOMATION_SIGNAL_ARGS = new Set([
  '--enable-automation',
  '--enable-blink-features=IdleDetection',
]);

/**
 * Build launch args for Playwright chromium.launch / launchPersistentContext.
 * Strips any automation-enable flags from extras.
 */
export function buildHardenedLaunchArgs(opts: LaunchHardeningOptions = {}): string[] {
  const width = opts.windowWidth ?? 1366;
  const height = opts.windowHeight ?? 900;
  const lang = opts.lang ?? 'en-US';

  const args = [
    ...resolveHardenedBaseArgs(),
    `--window-size=${width},${height}`,
    `--lang=${lang}`,
  ];

  if (opts.useRealGpu) {
    args.push('--use-angle=gl', '--use-gl=desktop');
  } else {
    args.push('--disable-gpu');
  }

  if (opts.headless) {
    args.push('--headless=new');
  }

  for (const extra of opts.extraArgs ?? []) {
    if (AUTOMATION_SIGNAL_ARGS.has(extra)) continue;
    if (extra.includes('enable-automation')) continue;
    args.push(extra);
  }

  return args;
}

/** Playwright context options aligned with hardened launch */
export function hardenedContextOptions(fp: {
  userAgent: string;
  locale?: string;
  timezoneId?: string;
  viewport?: { width: number; height: number };
}): Record<string, unknown> {
  return {
    userAgent: fp.userAgent,
    locale: fp.locale ?? 'en-US',
    timezoneId: fp.timezoneId ?? 'America/New_York',
    viewport: fp.viewport ?? { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    javaScriptEnabled: true,
    bypassCSP: false,
    ignoreHTTPSErrors: false,
    permissions: [],
  };
}
