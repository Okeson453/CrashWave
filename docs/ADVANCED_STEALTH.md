# Advanced Stealth Layer v2

Implemented 2026-08-20. Raises detection cost against Cloudflare / DataDome / PerimeterX-style checks.

## Capabilities

| Technique | Status |
|-----------|--------|
| `navigator.webdriver` | Hidden |
| Canvas fingerprint noise (seeded) | Yes |
| Audio fingerprint noise (seeded) | Yes |
| WebRTC / media device leak reduction | Yes |
| Client Hints (`sec-ch-ua`) JS + CDP | Yes |
| Full `window.chrome` stub | Yes |
| Plugins realism | Yes |
| CDP User-Agent override | Yes |
| Playwright global cleanup | Yes |
| Session-stable seeds via FingerprintProfile | Yes |
| Behavioral helpers (`humanize.ts` + `HumanInput`) | Yes |

## Integration

- `BrowserManager.launch` applies `STEALTH_BROWSER_ARGS`, `applyStealthToContext`, `applyStealthToPage`
- Fingerprints come from `loadOrCreateFingerprint` (stable for profile lifetime)
- Live actions use `HumanInput` / `humanClick` / `humanType`

## Honesty

Does **not** guarantee undetectability. Combine with residential proxies, reasonable frequency, headed mode for live, and multi-step live confirmation.
