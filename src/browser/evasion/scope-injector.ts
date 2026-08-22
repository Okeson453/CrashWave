/**
 * Cross-context scope injector — workers & same-origin iframes.
 *
 * Engineering constraints:
 * - Module workers (type:'module') cannot use importScripts.
 * - Cross-origin classic workers cannot importScripts foreign URLs from a blob.
 * - Double-wrapping Worker is avoided via a global install flag.
 * - We only inject a *small* navigator hygiene bootstrap into workers, not the
 *   full main-world stealth bundle (which assumes window/document).
 */

export interface ScopeInjectorConfig {
  /** Optional extra classic-worker preamble (must not assume DOM) */
  workerPreamble?: string;
  injectWorkers: boolean;
  injectSharedWorkers: boolean;
  injectIframes: boolean;
  /** Main-world evasion string for same-origin iframes only */
  iframeBundle?: string;
}

const DEFAULT_WORKER_PREAMBLE = `
try {
  if (typeof navigator !== 'undefined') {
    try { Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; }, configurable: true }); } catch (e) {}
  }
} catch (e) {}
`;

export function generateScopeInjectorScript(config: ScopeInjectorConfig): string {
  const preamble = JSON.stringify((config.workerPreamble || DEFAULT_WORKER_PREAMBLE).trim());
  const iframeBundle = JSON.stringify(config.iframeBundle || '');
  return `
(function() {
  'use strict';
  if (window.__sheathScopeInstalled) return;
  try { Object.defineProperty(window, '__sheathScopeInstalled', { value: 1, configurable: false }); } catch (e) { window.__sheathScopeInstalled = 1; }

  var PREAMBLE = ${preamble};
  var IFRAME_BUNDLE = ${iframeBundle};
  var injectWorkers = ${config.injectWorkers ? 'true' : 'false'};
  var injectShared = ${config.injectSharedWorkers ? 'true' : 'false'};
  var injectIframes = ${config.injectIframes ? 'true' : 'false'};

  function isModuleOptions(options) {
    return options && (options.type === 'module' || options.type === 'modules');
  }

  function wrapClassicWorkerUrl(scriptURL) {
    try {
      var urlStr = String(scriptURL);
      // Only rewrite relative / same-origin-ish classic scripts
      if (/^https?:/i.test(urlStr) && urlStr.indexOf(location.origin) !== 0) {
        return scriptURL; // cross-origin: leave alone
      }
      var code = PREAMBLE + '\\ntry { importScripts(' + JSON.stringify(urlStr) + '); } catch (e) {}';
      var blob = new Blob([code], { type: 'application/javascript' });
      return URL.createObjectURL(blob);
    } catch (e) {
      return scriptURL;
    }
  }

  if (injectWorkers && typeof window.Worker === 'function' && !window.Worker.__sheathWrapped) {
    try {
      var NativeWorker = window.Worker;
      function SheathWorker(scriptURL, options) {
        if (isModuleOptions(options)) {
          return new NativeWorker(scriptURL, options);
        }
        return new NativeWorker(wrapClassicWorkerUrl(scriptURL), options);
      }
      SheathWorker.prototype = NativeWorker.prototype;
      try { SheathWorker.__sheathWrapped = true; } catch (e) {}
      window.Worker = SheathWorker;
    } catch (e) {}
  }

  if (injectShared && typeof window.SharedWorker === 'function' && !window.SharedWorker.__sheathWrapped) {
    try {
      var NativeShared = window.SharedWorker;
      function SheathShared(scriptURL, options) {
        if (isModuleOptions(options)) {
          return new NativeShared(scriptURL, options);
        }
        return new NativeShared(wrapClassicWorkerUrl(scriptURL), options);
      }
      SheathShared.prototype = NativeShared.prototype;
      try { SheathShared.__sheathWrapped = true; } catch (e) {}
      window.SharedWorker = SheathShared;
    } catch (e) {}
  }

  if (injectIframes && IFRAME_BUNDLE) {
    try {
      var nativeCreate = document.createElement.bind(document);
      document.createElement = function(tag, opts) {
        var el = nativeCreate(tag, opts);
        if (String(tag).toLowerCase() === 'iframe') {
          el.addEventListener('load', function() {
            try {
              var doc = el.contentDocument;
              if (!doc) return; // cross-origin
              var s = doc.createElement('script');
              s.textContent = IFRAME_BUNDLE;
              (doc.documentElement || doc).appendChild(s);
            } catch (e) {}
          });
        }
        return el;
      };
    } catch (e) {}
  }
})();`;
}
