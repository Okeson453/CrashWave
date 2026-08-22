/**
 * Advanced Stealth Layer v2
 * Targets modern anti-bot systems (Cloudflare, DataDome, PerimeterX, custom casino bots).
 * Integrates with session-stable FingerprintProfile (never mutate mid-session).
 */

import { BrowserContext, Page, CDPSession } from 'playwright';
import { FingerprintProfile } from './fingerprint';
import { getLogger } from '../observability/logger';

const logger = getLogger();

export interface StealthFingerprint {
  userAgent: string;
  platform: string;
  languages: string[];
  vendor: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  webglVendor: string;
  webglRenderer: string;
  colorDepth: number;
  pixelRatio: number;
  secChUa: string;
  secChUaMobile: string;
  secChUaPlatform: string;
  vendorSub: string;
  productSub: string;
  appVersion: string;
  canvasNoiseSeed?: string;
  audioNoiseSeed?: string;
}

export const DEFAULT_STEALTH_FINGERPRINT: StealthFingerprint = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  platform: 'Win32',
  languages: ['en-US', 'en'],
  vendor: 'Google Inc.',
  hardwareConcurrency: 8,
  deviceMemory: 8,
  maxTouchPoints: 0,
  webglVendor: 'Google Inc. (NVIDIA)',
  webglRenderer:
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)',
  colorDepth: 24,
  pixelRatio: 1,
  secChUa: '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
  secChUaMobile: '?0',
  secChUaPlatform: '"Windows"',
  vendorSub: '',
  productSub: '20030107',
  appVersion:
    '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};

export function fingerprintToStealth(fp: FingerprintProfile): StealthFingerprint {
  return {
    userAgent: fp.userAgent,
    platform: fp.platform,
    languages: fp.languages,
    vendor: fp.vendor,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    maxTouchPoints: 0,
    webglVendor: fp.webglVendor,
    webglRenderer: fp.webglRenderer,
    colorDepth: fp.screen.colorDepth,
    pixelRatio: fp.devicePixelRatio,
    secChUa: fp.secChUa,
    secChUaMobile: '?0',
    secChUaPlatform: fp.secChUaPlatform,
    vendorSub: '',
    productSub: '20030107',
    appVersion: fp.userAgent.replace(/^Mozilla\//, ''),
    canvasNoiseSeed: fp.canvasNoiseSeed,
    audioNoiseSeed: fp.audioNoiseSeed,
  };
}

export const STEALTH_BROWSER_ARGS = [
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
  '--window-size=1366,900',
  '--lang=en-US',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-component-update',
];

export function stealthLaunchArgs(disableAutomationControlled = true): string[] {
  // Prefer hardened builder — never emit --enable-automation
  try {
    // Lazy require-style import avoided; inline hardened set
    const args = [...STEALTH_BROWSER_ARGS];
    if (!disableAutomationControlled) {
      return args.filter((a) => !a.includes('AutomationControlled'));
    }
    // Strip any accidental enable-automation from external merges
    return args.filter((a) => !a.includes('enable-automation'));
  } catch {
    return [...STEALTH_BROWSER_ARGS];
  }
}

/** Hardened args with optional real GPU / viewport — see evasion/launch-config */
export { buildHardenedLaunchArgs, hardenedContextOptions } from './evasion/launch-config.js';

export function buildAdvancedStealthInitScript(fp: StealthFingerprint): string {
  return `
(function() {
  'use strict';
  const fp = ${JSON.stringify(fp)};

  function seededRandom(seedStr) {
    let h = 0;
    for (let i = 0; i < (seedStr || 'x').length; i++) {
      h = ((h << 5) - h) + seedStr.charCodeAt(i);
      h |= 0;
    }
    return function() {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      const t = (h ^= h >>> 16) >>> 0;
      return (t & 0xfffffff) / 0x10000000;
    };
  }
  const canvasRand = seededRandom(fp.canvasNoiseSeed || 'canvas');
  const audioRand = seededRandom(fp.audioNoiseSeed || 'audio');

  const navigatorOverrides = {
    webdriver: undefined,
    languages: fp.languages,
    language: fp.languages[0],
    platform: fp.platform,
    vendor: fp.vendor,
    vendorSub: fp.vendorSub,
    productSub: fp.productSub,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    maxTouchPoints: fp.maxTouchPoints,
    appVersion: fp.appVersion,
  };
  for (const [key, value] of Object.entries(navigatorOverrides)) {
    try {
      Object.defineProperty(navigator, key, { get: () => value, configurable: true });
    } catch (e) {}
  }

  try {
    window.chrome = {
      runtime: {
        onConnect: { addListener: function() {}, removeListener: function() {} },
        onMessage: { addListener: function() {}, removeListener: function() {} },
        connect: function() {
          return { onMessage: { addListener: function() {} }, postMessage: function() {}, disconnect: function() {} };
        },
        sendMessage: function() {},
        id: undefined,
      },
      loadTimes: function() {
        return {
          commitLoadTime: Date.now() / 1000 - 1,
          connectionInfo: 'h2',
          finishDocumentLoadTime: Date.now() / 1000 - 0.5,
          finishLoadTime: Date.now() / 1000 - 0.3,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: Date.now() / 1000 - 0.8,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000 - 1.2,
          startLoadTime: Date.now() / 1000 - 1.1,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
        };
      },
      csi: function() {
        return { startE: Date.now(), onloadT: Date.now(), pageT: Math.random() * 1000, tran: 15 };
      },
      app: {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      },
    };
  } catch (e) {}

  try {
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query
      ? window.navigator.permissions.query.bind(window.navigator.permissions)
      : null;
    if (originalQuery) {
      window.navigator.permissions.query = function(parameters) {
        return parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : originalQuery(parameters);
      };
    }
  } catch (e) {}

  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const data = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        data.item = (i) => data[i] || null;
        data.namedItem = (n) => data.find((p) => p.name === n) || null;
        data.refresh = () => {};
        return data;
      },
      configurable: true,
    });
  } catch (e) {}

  try {
    const patch = (proto) => {
      const getParameter = proto.getParameter;
      proto.getParameter = function(param) {
        if (param === 37445) return fp.webglVendor;
        if (param === 37446) return fp.webglRenderer;
        return getParameter.call(this, param);
      };
    };
    patch(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patch(WebGL2RenderingContext.prototype);
  } catch (e) {}

  try {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    const getImageData = CanvasRenderingContext2D.prototype.getImageData;
    const noisify = (canvas, context) => {
      if (!context) return;
      const width = canvas.width, height = canvas.height;
      if (width <= 0 || height <= 0) return;
      try {
        const imageData = getImageData.call(context, 0, 0, Math.min(width, 16), Math.min(height, 16));
        for (let i = 0; i < imageData.data.length; i += 4) {
          const n = Math.floor(canvasRand() * 6) - 3;
          imageData.data[i] = (imageData.data[i] + n) & 255;
          imageData.data[i + 1] = (imageData.data[i + 1] + n) & 255;
          imageData.data[i + 2] = (imageData.data[i + 2] + n) & 255;
        }
        context.putImageData(imageData, 0, 0);
      } catch (e) {}
    };
    HTMLCanvasElement.prototype.toBlob = function(cb, type, quality) {
      noisify(this, this.getContext('2d'));
      return toBlob.call(this, cb, type, quality);
    };
    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
      noisify(this, this.getContext('2d'));
      return toDataURL.call(this, type, quality);
    };
  } catch (e) {}

  try {
    const originalGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function() {
      const results = originalGetChannelData.apply(this, arguments);
      for (let i = 0; i < results.length; i += 100) {
        results[i] = results[i] + (audioRand() * 0.0001 - 0.00005);
      }
      return results;
    };
  } catch (e) {}

  try {
    const OriginalRTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (OriginalRTC) {
      const Wrapped = function(...args) {
        const pc = new OriginalRTC(...args);
        const origCreateOffer = pc.createOffer.bind(pc);
        pc.createOffer = async function(...oArgs) {
          const offer = await origCreateOffer(...oArgs);
          if (offer && offer.sdp) {
            offer.sdp = offer.sdp.replace(/a=candidate:.*\\r\\n/g, '');
          }
          return offer;
        };
        return pc;
      };
      Wrapped.prototype = OriginalRTC.prototype;
      window.RTCPeerConnection = Wrapped;
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped;
    }
  } catch (e) {}

  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices = () => Promise.resolve([]);
    }
  } catch (e) {}

  try {
    Object.defineProperty(screen, 'colorDepth', { get: () => fp.colorDepth });
    Object.defineProperty(screen, 'pixelDepth', { get: () => fp.colorDepth });
  } catch (e) {}

  try {
    delete window.__playwright;
    delete window.__pw_manual;
    delete window.__PW_inspect;
    delete window.playwright;
  } catch (e) {}

  try {
    if (typeof Notification !== 'undefined') {
      Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
    }
  } catch (e) {}
})();
`;
}

export function buildStealthInitScript(fp: StealthFingerprint): string {
  return buildAdvancedStealthInitScript(fp);
}

export async function applyCdpStealth(page: Page, fp: StealthFingerprint): Promise<void> {
  try {
    if (typeof page.context !== 'function') return;
    const ctx = page.context();
    if (!ctx || typeof ctx.newCDPSession !== 'function') return;
    const client: CDPSession = await ctx.newCDPSession(page);
    await client.send('Network.setUserAgentOverride', {
      userAgent: fp.userAgent,
      acceptLanguage: fp.languages.join(','),
      platform: fp.platform,
      userAgentMetadata: {
        brands: [
          { brand: 'Chromium', version: '128' },
          { brand: 'Not;A=Brand', version: '24' },
          { brand: 'Google Chrome', version: '128' },
        ],
        fullVersion: '128.0.0.0',
        platform: fp.platform === 'MacIntel' ? 'macOS' : 'Windows',
        platformVersion: fp.platform === 'MacIntel' ? '14.0.0' : '15.0.0',
        architecture: 'x86',
        model: '',
        mobile: false,
      },
    });
    await client.send('Network.setExtraHTTPHeaders', {
      headers: {
        'sec-ch-ua': fp.secChUa,
        'sec-ch-ua-mobile': fp.secChUaMobile,
        'sec-ch-ua-platform': fp.secChUaPlatform,
        'Accept-Language': fp.languages.join(',') + ';q=0.9',
      },
    });
    logger.debug({ component: 'Stealth' }, 'CDP User-Agent + Client Hints applied');
  } catch (err) {
    logger.warn({ component: 'Stealth', error: String(err) }, 'CDP stealth application failed (non-fatal)');
  }
}

export async function applyStealthToContext(
  context: BrowserContext,
  fingerprint: FingerprintProfile | StealthFingerprint = DEFAULT_STEALTH_FINGERPRINT,
  _options?: { canvasNoise?: boolean; webglNoise?: boolean; audioNoise?: boolean }
): Promise<void> {
  if (typeof context.addInitScript !== 'function') {
    logger.debug({ component: 'Stealth' }, 'Context does not support addInitScript; skipping');
    return;
  }
  const fp: StealthFingerprint =
    'profileId' in (fingerprint as object)
      ? fingerprintToStealth(fingerprint as FingerprintProfile)
      : (fingerprint as StealthFingerprint);

  await context.addInitScript(buildAdvancedStealthInitScript(fp));
  try {
    const { buildDeepFingerprintScript } = await import('./evasion/deep-fingerprint.js');
    const { CDPSanitizer } = await import('./evasion/cdp-sanitizer.js');
    await context.addInitScript(
      buildDeepFingerprintScript({
        hardwareConcurrency: fp.hardwareConcurrency,
        deviceMemory: fp.deviceMemory,
        platform: fp.platform,
        seed: fp.canvasNoiseSeed,
      })
    );
    await context.addInitScript(CDPSanitizer.buildDetectionPatchScript());
  } catch (err) {
    logger.debug({ component: 'Stealth', error: String(err) }, 'Deep fingerprint / CDP patch skipped');
  }
  try {
    await context.setExtraHTTPHeaders({
      'Accept-Language': fp.languages.join(',') + ';q=0.9',
      'sec-ch-ua': fp.secChUa,
      'sec-ch-ua-mobile': fp.secChUaMobile,
      'sec-ch-ua-platform': fp.secChUaPlatform,
    });
  } catch {
    /* mock / closed */
  }
  logger.info(
    { component: 'Stealth', userAgent: fp.userAgent.slice(0, 48) + '...' },
    'Advanced stealth + deep fingerprint + CDP patches applied to context'
  );
}

export async function applyStealthToPage(
  page: Page,
  fingerprint: FingerprintProfile | StealthFingerprint = DEFAULT_STEALTH_FINGERPRINT
): Promise<void> {
  const fp: StealthFingerprint =
    'profileId' in (fingerprint as object)
      ? fingerprintToStealth(fingerprint as FingerprintProfile)
      : (fingerprint as StealthFingerprint);
  const script = buildAdvancedStealthInitScript(fp);
  if (typeof page.addInitScript === 'function') {
    try {
      await page.addInitScript(script);
    } catch (err) {
      logger.debug({ component: 'Stealth', error: String(err) }, 'page.addInitScript failed');
    }
  }
  await applyCdpStealth(page, fp);
  try {
    const { buildDeepFingerprintScript } = await import('./evasion/deep-fingerprint.js');
    const { CDPSanitizer } = await import('./evasion/cdp-sanitizer.js');
    const deep = buildDeepFingerprintScript({
      hardwareConcurrency: fp.hardwareConcurrency,
      deviceMemory: fp.deviceMemory,
      platform: fp.platform,
      seed: fp.canvasNoiseSeed,
    });
    if (typeof page.addInitScript === 'function') {
      await page.addInitScript(deep);
      await page.addInitScript(CDPSanitizer.buildDetectionPatchScript());
    }
    await page.evaluate(deep);
  } catch (err) {
    logger.debug({ component: 'Stealth', error: String(err) }, 'Deep fingerprint page inject skipped');
  }
  try {
    await page.evaluate(script);
  } catch {
    /* not ready */
  }
}

export async function applyStealthHintsToPage(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch {
        /* ignore */
      }
    });
  } catch (err) {
    logger.debug({ component: 'Stealth', error: String(err) }, 'Page stealth hint failed');
  }
}
