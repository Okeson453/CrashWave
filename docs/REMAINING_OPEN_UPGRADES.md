# Remaining Open Upgrades & Fixes

**Status after enterprise detection + operational gap closure (2026-08-20)**

Most engineering gaps are closed. What remains is **operational / external**, not missing core code.

| Item | Status | Notes |
|------|--------|-------|
| Residential proxy code path | **CLOSED** | ProxyManager + config + BrowserManager wiring; **ops must enable with quality provider** |
| Headed mode for live | **CLOSED** | `toLaunchOptions` forces `headless=false` when mode=live and preferNonHeadlessForLive |
| Operator re-auth protocol | **CLOSED** | `ReauthProtocol` + `/reauth_complete` handler factory; no automated password login (by design) |
| Account-link monitoring | **CLOSED** | `AccountLinkMonitor` baseline on composition start |
| Soak harness | **CLOSED** | `scripts/soak-observe.ts` — run ≥2h before live |
| Single-instance verification | **CLOSED** | `scripts/verify-single-instance.ts` + InstanceLock unit tests |
| Redis dual-client mutex | **CLOSED (conditional)** | Runs when `REDIS_URL` set |
| Telemetry noise | **Intentionally off** | Enable only if deterministic patterns are flagged |
| Multi-hour soak under real BC.Game | **Ops evidence** | Harness exists; evidence collected in target environment |
| Live-money go-live | **Checklist** | See `docs/live-deployment-checklist.md` |

## Honesty

- Proxy quality and sticky configuration determine most residual detection risk.
- Auth remains operator-driven after cookie expiry — safe by design.
- Economic / platform (house edge, ToS) risk is outside the codebase.
- Controlled observe-only and dry-run are the correct next steps before any live capital.
