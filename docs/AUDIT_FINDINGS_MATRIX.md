# CrashWave Audit Findings Matrix

Authoritative remediation log. Findings are never deleted; status advances through lifecycle.

| ID | Component | Path | Classification | Severity | Root cause | Crash ref | Required fix | Status | Verif 1/2/3 | Commit | Notes |
|----|-----------|------|----------------|----------|------------|-----------|--------------|--------|-------------|--------|-------|
| F001 | Auth/Login one-shot | `src/browser/live-login.ts` + composition | BROKEN | P0 | Login closed browser; no observation | `SessionSupervisor` | Persistent SessionSupervisor | CLOSED | Y/Y/Y | `35264d8` | SessionSupervisor wired |
| F002 | Observation loop absent | composition | BROKEN | P0 | No GameAdapter/Observer started | SessionSupervisor.initializeObservation | Start adapter+observer, emit events | CLOSED | Y/Y/Y | `35264d8` | Events on bus |
| F003 | Playwright path env | Dockerfile/compose/.env | BROKEN | P0 | PLAYWRIGHT_BROWSERS_PATH empty dir | n/a | Align path + symlink | CLOSED | Y/Y/Y | `da55884` | |
| F004 | Geo misclassified | login pipeline | PARTIAL | P1 | Region modal → LOGIN_FORM_UNAVAILABLE | region detector | Detect /block + settle | CLOSED | Y/Y/Y | `0767e7e` | |
| F005 | LiveBetExecutor missing | `src/betting/` | MISSING | P0 | Only factory comment | `live-executor.ts` | Implement + wire | IMPLEMENTED | pending | this cycle | |
| F006 | Live signal path | composition | BROKEN | P0 | No live bridge | Crash live wiring | live-bridge.ts | IMPLEMENTED | pending | this cycle | |
| F007 | Round persistence | composition | DISCONNECTED | P1 | Events not written | Orchestrator persist | roundRepo on events | IMPLEMENTED | pending | this cycle | |
| F008 | Proxy resolve | proxy-manager | PARTIAL | P1 | Only PROXY_URL | Crash proxy | APP_PROXY__* | IMPLEMENTED | pending | this cycle | |
| F009 | BC.Game geo on cloud IP | runtime | EXTERNAL | P0 | Railway/cloud IP → /block | n/a | SEA residential proxy | OPEN | n/a | Ops | Not code |
| F010 | Live cash-out | betting | MISSING | P1 | No executor | live-cashout.ts | Implement | IMPLEMENTED | pending | this cycle | |
| F011 | Workers starved | workers | PARTIAL | P2 | No payloads without observation | event feed | Observation emits | PARTIAL | — | Depends F002 | |
| F012 | Prediction cold start | entry-decision | PARTIAL | P1 | Live needs warm history | prewarm | ensureWarmed on start | OPEN | — | Next | |
| F013 | ALLOW_REAL_EXECUTION gate | execution-mode-gate | WORKING | — | Fail-closed | gate | Keep | CLOSED | Y/Y/Y | existing | Dry-run safe |
| F014 | Dry-run isolation | dry-run-bridge | WORKING | — | mode!==dry-run return | same | Keep | CLOSED | Y/Y/Y | existing | |

## Lifecycle legend
DISCOVERED → … → CLOSED. OPEN = external or deferred. IMPLEMENTED = code present, verifications in progress.

## Mode isolation
- Dry-run: `onRoundStartedForDryRun` returns unless mode dry-run/observe-only; never calls LiveBetExecutor.
- Live: `onRoundStartedForLive` requires mode=live AND `isRealExecutionAllowed()` (ALLOW_REAL_EXECUTION + mode).
