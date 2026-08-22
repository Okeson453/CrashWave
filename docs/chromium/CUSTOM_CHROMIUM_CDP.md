# Custom Chromium — CDP Leak Eradication

Runtime JavaScript patches (`navigator.webdriver = undefined` via
`page.evaluateOnNewDocument`) are detectable through
`Object.getOwnPropertyDescriptor(navigator, 'webdriver')`.

Production requires **compile-time** removal of automation indicators.

## Build targets (Chromium source)

| Area | Path (approx.) | Change |
|------|----------------|--------|
| `navigator.webdriver` | `third_party/blink/renderer/core/frame/navigator.cc` / `v8_navigator.cc` | Force `false` / omit binding |
| CDP markers | Search for `cdc_` in `chrome/` and Blink | Strip string constants |
| Automation controlled | `content/browser/` flags, `--enable-automation` | Default off; do not pass flag |
| Permissions / notifications | Blink permission automation hooks | Neutralize test-only paths |

## Build sketch

```bash
# Depot tools + fetch chromium (major version aligned with Playwright)
fetch chromium
cd src
git checkout <tag matching Playwright Chrome version>

# Apply patches from docs/chromium/patches/ (maintain downstream)
gn gen out/Default --args='is_debug=false is_component_build=false symbol_level=0'
autoninja -C out/Default chrome

# Point Playwright at the binary
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/out/Default/chrome
```

## Runtime config

```yaml
browser:
  executablePath: ${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}
  stealth:
    enabled: true
    preferNonHeadlessForLive: true
specUpgrade:
  stealth:
    protocolOffload: true   # browser only for challenges + cookie capture
```

## Verification

1. `Object.getOwnPropertyDescriptor(navigator, 'webdriver')` → `undefined` or non-configurable `false` without JS override traces.
2. No `cdc_` keys on `window` / `document`.
3. JA4/TLS fingerprint matches chosen profile (via external JA4 checker).
4. Cross-attribute matrix consistent (UA, WebGL, fonts, platform).

## Operational note

Ship the binary via internal artifact store; pin hash in deploy checklist.
Do not rely solely on `puppeteer-extra-plugin-stealth` for live capital.
