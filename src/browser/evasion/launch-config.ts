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

/** Core stealth flags — never include --enable-automation */
export const HARDENED_LAUNCH_ARGS: readonly string[] = Object.freeze([
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process,AutomationControlled,TranslateUI,IdleDetection,AudioServiceOutOfProcess',
  '--disable-site-isolation-trials',
  '--disable-infobars',
  '--disable-dev-shm-usage',
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
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--use-mock-keychain',
  '--force-color-profile=srgb',
  '--export-tagged-pdf',
  '--hide-scrollbars',
  '--mute-audio',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-component-update',
]);

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
    ...HARDENED_LAUNCH_ARGS,
    `--window-size=${width},${height}`,
    `--lang=${lang}`,
  ];

  if (opts.useRealGpu) {
    args.push('--use-angle=gl', '--use-gl=desktop');
  } else {
    // Software path still needs consistent GPU flags for WebGL spoof
    args.push('--disable-gpu');
  }

  if (opts.headless) {
    // new headless is less detectable than old chrome headless
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
    // Reduce Playwright automation markers in permissions
    permissions: [],
  };
}
