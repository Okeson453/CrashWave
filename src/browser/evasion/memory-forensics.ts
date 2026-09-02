/**
 * Memory / stack forensics evasion init script.
 * Scrubs Playwright markers from stacks and global leakage points.
 */

export interface MemoryForensicsConfig {
  scrubKeywords: string[];
  antiDebug: boolean;
  snapshotProtection: boolean;
  globalHygiene: boolean;
}

export const DEFAULT_MEMORY_CONFIG: MemoryForensicsConfig = {
  scrubKeywords: [
    'playwright',
    '__playwright',
    'pptr:',
    'puppeteer',
    'devtools',
    'WebDriver',
    'cdc_',
  ],
  antiDebug: true,
  snapshotProtection: true,
  globalHygiene: true,
};

export function generateMemoryForensicsScript(
  config: Partial<MemoryForensicsConfig> = {}
): string {
  const c = { ...DEFAULT_MEMORY_CONFIG, ...config };
  const keywords = JSON.stringify(c.scrubKeywords);

  return `
(function() {
  'use strict';
  if (window.__sheathMemory) return;
  try { Object.defineProperty(window, '__sheathMemory', { value: 1, configurable: false }); } catch (e) {}
  var KEYWORDS = ${keywords};

  function looksBad(s) {
    if (!s) return false;
    var lower = String(s).toLowerCase();
    for (var i = 0; i < KEYWORDS.length; i++) {
      if (lower.indexOf(KEYWORDS[i].toLowerCase()) !== -1) return true;
    }
    return false;
  }

  try {
    var nativePrepare = Error.prepareStackTrace;
    Error.prepareStackTrace = function(err, stack) {
      try {
        var filtered = (stack || []).filter(function(f) { return !looksBad(f.toString()); });
        if (nativePrepare) return nativePrepare(err, filtered);
        return filtered.map(function(f) { return '    at ' + f.toString(); }).join('\\n');
      } catch (e) {
        return nativePrepare ? nativePrepare(err, stack) : String(err && err.stack);
      }
    };
  } catch (e) {}

  try {
    var desc = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
    if (desc && desc.get) {
      var origGet = desc.get;
      Object.defineProperty(Error.prototype, 'stack', {
        configurable: true,
        enumerable: false,
        get: function() {
          var s = origGet.call(this);
          if (typeof s !== 'string') return s;
          return s.split('\\n').filter(function(line) { return !looksBad(line); }).join('\\n');
        }
      });
    }
  } catch (e) {}

  ${c.globalHygiene ? `
  try {
    var names = Object.getOwnPropertyNames(window);
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (n.indexOf('__playwright') === 0 || n.indexOf('__pw_') === 0 || n.indexOf('cdc_') === 0) {
        try { delete window[n]; } catch (e) {}
      }
    }
  } catch (e) {}
  ` : ''}

  ${c.antiDebug ? `
  try {
    // Discourage trivial debugger traps without breaking legitimate tooling
    var _c = console;
    if (_c && _c.clear) {
      /* no-op: presence of console is normal */
    }
  } catch (e) {}
  ` : ''}

  try {
    var navProto = Navigator.prototype;
    var webdriverDesc = Object.getOwnPropertyDescriptor(navProto, 'webdriver');
    if (webdriverDesc) {
      Object.defineProperty(navProto, 'webdriver', {
        get: function() { return undefined; },
        enumerable: false,
        configurable: true,
      });
    }
  } catch (e) {}
})();`;
}
