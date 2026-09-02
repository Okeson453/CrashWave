import { BrowserConfig } from '../config/schema';
import { STEALTH_BROWSER_ARGS, DEFAULT_STEALTH_FINGERPRINT, StealthFingerprint } from './stealth';

export interface BrowserLaunchOptions {
  headless: boolean;
  viewport: {
    width: number;
    height: number;
  };
  userDataDir: string;
  timeoutMs: number;
  args?: string[];
  env?: Record<string, string>;
  /** Enable advanced stealth (default true) */
  stealth?: boolean;
  /** Optional stealth fingerprint override */
  fingerprint?: StealthFingerprint;
  timezoneId?: string;
  locale?: string;
  proxy?: { server: string; username?: string; password?: string };
  proxyGeo?: string | null;
}

export interface BrowserSessionState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
    sessionStorage: Array<{ name: string; value: string }>;
  }>;
  timestamp: string;
  version: number;
}

export interface EncryptedSessionState {
  encrypted: string;
  iv: string;
  tag: string;
  timestamp: string;
  version: number;
}

export interface BrowserProfile {
  id: string;
  directory: string;
  createdAt: string;
  lastUsedAt: string;
  useCount: number;
  sessionCount: number;
}

export interface BrowserHealthMetrics {
  pageResponsive: boolean;
  lastResponseMs: number;
  memoryUsageMB: number;
  jsHeapSizeMB: number;
  domNodeCount: number;
  wsConnected: boolean;
  lastTickAt: string | null;
  frozen: boolean;
}

export interface BrowserManagerState {
  launched: boolean;
  pageUrl: string | null;
  authenticated: boolean;
  gameLoaded: boolean;
  profileId: string | null;
  launchedAt: string | null;
}

export interface NavigationResult {
  success: boolean;
  url: string;
  title: string;
  loadTimeMs: number;
  error?: string;
}

export interface AuthCheckResult {
  authenticated: boolean;
  username?: string;
  balance?: number;
  currency?: string;
  method: 'session-restore' | 'cookie' | 'manual' | 'unknown';
  /** True when BC.Game shows a geo/region restriction page (distinct from auth failure) */
  regionBlocked?: boolean;
  regionDetail?: string;
  detail?: string;
}

export type BrowserLifecyclePhase =
  | 'idle'
  | 'launching'
  | 'launched'
  | 'restoring-session'
  | 'authenticated'
  | 'navigating'
  | 'game-loaded'
  | 'closing'
  | 'closed'
  | 'error';

export interface BrowserLifecycleEvent {
  phase: BrowserLifecyclePhase;
  timestamp: string;
  detail?: string;
  error?: string;
}

/** @deprecated Prefer STEALTH_BROWSER_ARGS from stealth.ts */
export const DEFAULT_BROWSER_ARGS = STEALTH_BROWSER_ARGS;

export function toLaunchOptions(
  config: BrowserConfig,
  appProxy?: import('../config/schema').ProxyConfig,
  systemMode?: string
): BrowserLaunchOptions {
  // Docker / CI / servers without X11 cannot run headed Chromium.
  const hasDisplay = Boolean(process.env.DISPLAY && process.env.DISPLAY.trim());
  const envHeadless =
    process.env.BROWSER_HEADLESS === '1' ||
    process.env.BROWSER_HEADLESS === 'true' ||
    process.env.HEADLESS === '1' ||
    process.env.HEADLESS === 'true';
  const forceHeaded =
    process.env.BROWSER_FORCE_HEADED === '1' || process.env.BROWSER_FORCE_HEADED === 'true';
  const preferNonHeadless =
    (config as { stealth?: { preferNonHeadlessForLive?: boolean } }).stealth?.preferNonHeadlessForLive !== false;
  const wantHeadedForLive = preferNonHeadless && systemMode === 'live' && hasDisplay;
  let headless = config.headless;
  const productionLike =
    process.env.NODE_ENV === 'production' ||
    process.env.APP_ENV === 'production' ||
    process.env.BROWSER_HEADLESS === '1' ||
    process.env.BROWSER_HEADLESS === 'true';
  const allowHeaded =
    process.env.BROWSER_HEADLESS === 'false' || forceHeaded;
  if (envHeadless || productionLike) headless = true;
  if (wantHeadedForLive && hasDisplay && allowHeaded) headless = false;
  if (!hasDisplay && !forceHeaded) headless = true;
  if (forceHeaded && hasDisplay) headless = false;
  if (!hasDisplay) headless = true;

  const opts: BrowserLaunchOptions = {
    headless,
    viewport: {
      width: config.viewportWidth,
      height: config.viewportHeight,
    },
    userDataDir: config.profileDirectory,
    timeoutMs: config.timeoutMs,
    args: STEALTH_BROWSER_ARGS,
    stealth: true,
    fingerprint: DEFAULT_STEALTH_FINGERPRINT,
  };
  const networkProxy = (config as { network?: { proxyServer?: string | null } }).network?.proxyServer;
  if (appProxy?.enabled && (appProxy.server || (appProxy.pool && appProxy.pool.length > 0))) {
    (opts as BrowserLaunchOptions & { proxyConfig?: unknown }).proxyConfig = appProxy;
    if (appProxy.server) {
      opts.proxy = {
        server: appProxy.server.startsWith('http') ? appProxy.server : `http://${appProxy.server}`,
        username: appProxy.username ?? undefined,
        password: appProxy.password ?? undefined,
      };
    }
  } else if (networkProxy) {
    opts.proxy = { server: networkProxy };
  }
  return opts;
}
