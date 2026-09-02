/**
 * Deep fingerprint consistency patches (main world).
 * Idempotent: safe to inject once per document.
 *
 * Worker/iframe wrapping is delegated to scope-injector when used together
 * to avoid double-wrapping. This script still applies navigator/window patches
 * that workers do not need duplicated.
 */

export interface DeepFingerprintParams {
  hardwareConcurrency: number;
  deviceMemory: number;
  platform: string;
  outerWidthOffset?: number;
  outerHeightOffset?: number;
  historyLength?: number;
  seed?: string;
  /** If true, also wrap Worker (default false — use scope-injector instead) */
  patchWorkers?: boolean;
}

export function buildDeepFingerprintScript(p: DeepFingerprintParams): string {
  const outerW = p.outerWidthOffset ?? 16;
  const outerH = p.outerHeightOffset ?? 98;
  // Deterministic history length from seed to avoid fingerprint drift mid-session
  const histLen =
    p.historyLength ??
    (3 + (hash(p.seed || 'fp') % 5));
  const patchWorkers = p.patchWorkers === true;

  return `
(function() {
  'use strict';
  if (window.__sheathDeepFp) return;
  try { Object.defineProperty(window, '__sheathDeepFp', { value: 1, configurable: false }); } catch (e) { window.__sheathDeepFp = 1; }

  var HW = ${p.hardwareConcurrency};
  var MEM = ${p.deviceMemory};
  var PLATFORM = ${JSON.stringify(p.platform)};
  var OUTER_W_OFF = ${outerW};
  var OUTER_H_OFF = ${outerH};
  var HIST_LEN = ${histLen};

  function defineGetter(obj, prop, getter) {
    try {
      Object.defineProperty(obj, prop, { get: getter, configurable: true });
    } catch (e) {}
  }

  // Window chrome realism — only if dimensions look headless-flat
  try {
    var iw = window.innerWidth;
    var ih = window.innerHeight;
    if (window.outerWidth === iw || window.outerWidth === 0) {
      defineGetter(window, 'outerWidth', function() { return iw + OUTER_W_OFF; });
    }
    if (window.outerHeight === ih || window.outerHeight === 0) {
      defineGetter(window, 'outerHeight', function() { return ih + OUTER_H_OFF; });
    }
    if (window.screenX === 0 && window.screenY === 0) {
      defineGetter(window, 'screenX', function() { return 10 + (HW % 40); });
      defineGetter(window, 'screenY', function() { return 20 + (MEM % 30); });
      defineGetter(window, 'screenLeft', function() { return window.screenX; });
      defineGetter(window, 'screenTop', function() { return window.screenY; });
    }
  } catch (e) {}

  // performance.memory (Chromium-only API; define if missing)
  try {
    if (!('memory' in performance)) {
      var base = 40 * 1024 * 1024 + (HW * 2 * 1024 * 1024);
      defineGetter(performance, 'memory', function() {
        var jitter = Math.floor(Math.random() * 512 * 1024);
        return {
          jsHeapSizeLimit: 2048 * 1024 * 1024,
          totalJSHeapSize: base + jitter,
          usedJSHeapSize: Math.floor((base + jitter) * 0.55)
        };
      });
    }
  } catch (e) {}

  // credentials API presence
  try {
    if (!navigator.credentials) {
      Object.defineProperty(navigator, 'credentials', {
        get: function() {
          return {
            get: function() { return Promise.resolve(null); },
            store: function() { return Promise.resolve(undefined); },
            create: function() { return Promise.resolve(null); },
            preventSilentAccess: function() { return Promise.resolve(undefined); }
          };
        },
        configurable: true
      });
    }
  } catch (e) {}

  // history.length spoof only — spoof length only — avoid mutating the real session history
  try {
    defineGetter(window.history, 'length', function() { return HIST_LEN; });
  } catch (e) {}

  // sessionStorage seed (non-destructive)
  try {
    if (!sessionStorage.getItem('_bc_nav')) {
      sessionStorage.setItem('_bc_nav', String(HIST_LEN));
      sessionStorage.setItem('_bc_ts', String(Date.now() - 60000 - (HW * 1000)));
    }
  } catch (e) {}

  ${
    patchWorkers
      ? `
  // Optional worker wrap (prefer scope-injector in production)
  if (!window.__sheathScopeInstalled && window.Worker) {
    try {
      var NativeWorker = window.Worker;
      window.Worker = function(scriptURL, options) {
        if (options && options.type === 'module') return new NativeWorker(scriptURL, options);
        return new NativeWorker(scriptURL, options);
      };
      window.Worker.prototype = NativeWorker.prototype;
    } catch (e) {}
  }
  `
      : ''
  }
})();`;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
