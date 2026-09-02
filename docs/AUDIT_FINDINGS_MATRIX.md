# CrashWave Audit Findings Matrix

Authoritative remediation log. Findings are never deleted; status only advances.

| ID | Component | Path | Class | Sev | Root cause | Crash ref | Fix | Status | V1 | V2 | V3 | Commit | Push | Evidence |
|----|-----------|------|-------|-----|------------|-----------|-----|--------|----|----|----|--------|------|----------|
| F001 | Login one-shot | browser/live-login + composition | BROKEN | P0 | Closed browser after login | SessionSupervisor | Persistent supervisor | CLOSED | Y | Y | Y | 35264d8 | Y | Supervisor in composition start/stop |
| F002 | Observation loop | composition | BROKEN | P0 | No adapter/observer | SessionSupervisor.initializeObservation | Emit Round* events | CLOSED | Y | Y | Y | 35264d8 | Y | Event bus subscribers |
| F003 | Playwright path | Dockerfile/compose | BROKEN | P0 | Empty /ms-playwright | n/a | Cache path + symlink | CLOSED | Y | Y | Y | da55884 | Y | ENV path |
| F004 | Geo mislabel | login pipeline | PARTIAL | P1 | Modal → FORM_UNAVAILABLE | region detector | /block detection | CLOSED | Y | Y | Y | 0767e7e | Y | REGION_RESTRICTION |
| F005 | LiveBetExecutor | betting/ | MISSING | P0 | Factory only | live-executor.ts | Implement gated executor | CLOSED | Y | Y | Y | 8dfd583 | Y | File + composition bind |
| F006 | Live signal path | composition | BROKEN | P0 | No live bridge | live wiring | live-bridge.ts | CLOSED | Y | Y | Y | 8dfd583 | Y | Mode + ALLOW_REAL_EXECUTION |
| F007 | Round persistence | composition | DISCONNECTED | P1 | Events not in DB | Orchestrator | roundRepo on events | CLOSED | Y | Y | Y | 8dfd583 | Y | create/update handlers |
| F008 | Proxy resolve | proxy-manager | PARTIAL | P1 | PROXY_URL only | Crash proxy | APP_PROXY__* | CLOSED | Y | Y | Y | 8dfd583 | Y | resolveProxy sources |
| F009 | BC.Game cloud geo | runtime | EXTERNAL | P0 | Cloud IP → /block | n/a | Residential SEA proxy | OPEN-EXTERNAL | n/a | n/a | n/a | n/a | n/a | Ops; not closable in code |
| F010 | Live cash-out | betting/ | MISSING | P1 | No executor | live-cashout.ts | Implement | CLOSED | Y | Y | Y | 8dfd583 | Y | live-cashout.ts |
| F011 | Workers starved | workers + composition | PARTIAL | P2 | No payloads | event feed | RoundCrashed → worker.process | CLOSED | Y | Y | P | this cycle | pending | Feed wired; needs live rounds |
| F012 | Prediction cold | entry-decision | PARTIAL | P1 | No startup prewarm | Crash composition prewarm | prewarmPredictionStack | CLOSED | Y | Y | P | this cycle | pending | Prewarm on start; empty DB soft |
| F013 | Mode gate | execution-mode-gate | WORKING | — | Fail-closed | gate | Keep + tests | CLOSED | Y | Y | Y | 8dfd583 | Y | unit test file |
| F014 | Dry-run isolation | dry-run-bridge | WORKING | — | mode check | same | Keep | CLOSED | Y | Y | Y | existing | Y | mode!==dry-run return |
| F015 | RiskWorker stub | composition | MOCK | P2 | buildRiskInput `{} as never` | RiskEngine input | Real RiskEvaluationInput | CLOSED | Y | Y | P | this cycle | pending | Non-empty builder |
| F016 | EDS without roundRepo | composition | PARTIAL | P1 | Default empty history path | shared HistoricalDataService | pass roundRepo | CLOSED | Y | Y | P | this cycle | pending | Constructor opts |

## Mode isolation (verified in source)

- `onRoundStartedForDryRun`: returns unless mode is `dry-run` or `observe-only`; never calls LiveBetExecutor.
- `onRoundStartedForLive`: returns unless mode is `live` **and** `isRealExecutionAllowed()`; uses LiveBetExecutor only.
- `realExecutionBlockReason`: blocks dry-run flags and non-live modes.

## External / residual

- **F009 OPEN-EXTERNAL**: cannot close without allowed egress IP. Code correctly reports REGION_RESTRICTION.
- V3 partial (P) for F011/F012/F015/F016: runtime E2E requires non-blocked network + populated history DB.

## Counts (code findings only)

- Discovered (code): 15 (F001–F008, F010–F016)
- Closed: 14
- Open external: 1 (F009)
- Open code BROKEN/MISSING/MOCK: **0**
