/**
 * Session-stable multi-layer FingerprintProfile (R1-A).
 * Never mutate mid-session; rotate only with full profile rotation.
 */

import { createHash, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getLogger } from '../observability/logger';

export interface FingerprintProfile {
  version: number;
  profileId: string;
  userAgent: string;
  secChUa: string;
  secChUaPlatform: string;
  platform: string;
  vendor: string;
  languages: string[];
  timezoneId: string;
  locale: string;
  viewport: { width: number; height: number };
  screen: { width: number; height: number; colorDepth: number };
  devicePixelRatio: number;
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
  canvasNoiseSeed: string;
  audioNoiseSeed: string;
  fonts: string[];
  proxyGeo?: string | null;
  createdAt: string;
}

const PROFILE_VERSION = 1;

const DEFAULT_FONTS = [
  'Arial',
  'Helvetica',
  'Times New Roman',
  'Courier New',
  'Georgia',
  'Verdana',
  'Tahoma',
];

/** Realistic Chrome UA templates (desktop) */
const UA_TEMPLATES = [
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
    secChUaPlatform: '"Windows"',
    platform: 'Win32',
    vendor: 'Google Inc.',
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="127", "Not;A=Brand";v="24", "Google Chrome";v="127"',
    secChUaPlatform: '"Windows"',
    platform: 'Win32',
    vendor: 'Google Inc.',
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
    secChUaPlatform: '"Windows"',
    platform: 'Win32',
    vendor: 'Google Inc.',
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
    secChUaPlatform: '"macOS"',
    platform: 'MacIntel',
    vendor: 'Google Inc.',
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="127", "Not;A=Brand";v="24", "Google Chrome";v="127"',
    secChUaPlatform: '"macOS"',
    platform: 'MacIntel',
    vendor: 'Google Inc.',
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
  },
  {
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
    secChUaPlatform: '"Linux"',
    platform: 'Linux x86_64',
    vendor: 'Google Inc.',
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 OpenGL 4.5)',
  },
];

function seedFrom(profileId: string, salt: string): string {
  return createHash('sha256').update(`${profileId}:${salt}`).digest('hex').slice(0, 32);
}

export function createFingerprintProfile(
  profileId: string,
  options?: {
    timezoneId?: string;
    locale?: string;
    viewport?: { width: number; height: number };
    proxyGeo?: string | null;
    templateIndex?: number;
  }
): FingerprintProfile {
  const idx = options?.templateIndex ?? (parseInt(seedFrom(profileId, 'tpl').slice(0, 4), 16) % UA_TEMPLATES.length);
  const tpl = UA_TEMPLATES[idx % UA_TEMPLATES.length];
  const viewport = options?.viewport ?? { width: 1366, height: 900 };
  const hwOptions = [4, 6, 8, 12, 16];
  const memOptions = [4, 8, 8, 16];
  return {
    version: PROFILE_VERSION,
    profileId,
    userAgent: tpl.userAgent,
    secChUa: tpl.secChUa,
    secChUaPlatform: tpl.secChUaPlatform,
    platform: tpl.platform,
    vendor: tpl.vendor,
    languages: ['en-US', 'en'],
    timezoneId: options?.timezoneId ?? 'UTC',
    locale: options?.locale ?? 'en-US',
    viewport,
    screen: {
      width: viewport.width,
      height: viewport.height + 40,
      colorDepth: 24,
    },
    devicePixelRatio: 1,
    hardwareConcurrency: hwOptions[idx % hwOptions.length],
    deviceMemory: memOptions[idx % memOptions.length],
    webglVendor: tpl.webglVendor,
    webglRenderer: tpl.webglRenderer,
    canvasNoiseSeed: seedFrom(profileId, 'canvas'),
    audioNoiseSeed: seedFrom(profileId, 'audio'),
    fonts: [...DEFAULT_FONTS],
    proxyGeo: options?.proxyGeo ?? null,
    createdAt: new Date().toISOString(),
  };
}

export function fingerprintPath(profileDirectory: string): string {
  return join(profileDirectory, 'fingerprint.json');
}

export function loadOrCreateFingerprint(
  profileId: string,
  profileDirectory: string,
  options?: Parameters<typeof createFingerprintProfile>[1]
): FingerprintProfile {
  const path = fingerprintPath(profileDirectory);
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as FingerprintProfile;
      if (raw.profileId === profileId && raw.version === PROFILE_VERSION) {
        return raw;
      }
    } catch (err) {
      getLogger().warn(
        { component: 'Fingerprint', error: String(err) },
        'Failed to load fingerprint; creating new'
      );
    }
  }
  const fp = createFingerprintProfile(profileId, options);
  saveFingerprint(fp, profileDirectory);
  return fp;
}

export function saveFingerprint(fp: FingerprintProfile, profileDirectory: string): void {
  const path = fingerprintPath(profileDirectory);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fp, null, 2), { mode: 0o600 });
}

/** Build Playwright context options consistent with fingerprint */
export function fingerprintToContextOptions(fp: FingerprintProfile): {
  userAgent: string;
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  extraHTTPHeaders: Record<string, string>;
} {
  return {
    userAgent: fp.userAgent,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    viewport: { ...fp.viewport },
    deviceScaleFactor: fp.devicePixelRatio,
    extraHTTPHeaders: {
      'Accept-Language': fp.languages.join(',') + ';q=0.9',
      'sec-ch-ua': fp.secChUa,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': fp.secChUaPlatform,
    },
  };
}

export function newProfileId(): string {
  return `fp-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}
