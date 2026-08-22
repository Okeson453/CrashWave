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
  const preferNonHeadless =
    (config as { stealth?: { preferNonHeadlessForLive?: boolean } }).stealth?.preferNonHeadlessForLive !== false;
  const forceHeadedForLive = preferNonHeadless && systemMode === 'live';
  const opts: BrowserLaunchOptions = {
    headless: forceHeadedForLive ? false : config.headless,
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
  if (appProxy?.enabled && appProxy.server) {
    (opts as BrowserLaunchOptions & { proxyConfig?: unknown }).proxyConfig = appProxy;
    opts.proxy = {
      server: appProxy.server,
      username: appProxy.username,
      password: appProxy.password,
    };
  } else if (networkProxy) {
    opts.proxy = { server: networkProxy };
  }
  return opts;
}
