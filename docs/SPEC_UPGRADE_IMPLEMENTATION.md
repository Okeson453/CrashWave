# Spec Upgrade Implementation — Technical & Operational Specification

**Date:** 2026-08-21  
**Status:** Implemented (architecture + modules + wiring contracts)

This document maps every requirement from the Technical & Operational Specification
and the Stealth Infrastructure upgrade into concrete modules in this codebase.

---

## 1. Hardened Protocol & Stealth Architecture

| Requirement | Module | Status |
|---|---|---|
| Session handshaking & isolation (browser → native socket) | `src/protocol/session-handshake.ts` | DONE |
| TLS/JA4 stack mirroring | `src/network/tls/ja4-fingerprint.ts` | DONE (profile catalog + consistency guards) |
| Native TLS client wrapper contract | `src/network/tls/native-socket.ts` | DONE (Worker-thread WS; JA4 headers applied) |
| CDP leak eradication | Docs + `docs/ADVANCED_STEALTH.md` notes | PARTIAL — requires custom Chromium binary (ops) |
| Zod-backed payload ingestion + circuit breaker | `src/protocol/ws-payload-schemas.ts` | DONE |
| Immutable hardware profiles | `src/browser/profiles/immutable-hardware.ts` | DONE |
| Biomechanical input (Bezier + Poisson) | `src/browser/biomechanical-input.ts` | DONE |

### Session handoff flow

```
Playwright (headed) → captureSession() → HandshakeResult
       │
       ▼
buildNativeHeaders(handshake, ja4Profile)
       │
       ▼
NativeSocketWorker.start({ url, headers, ja4Profile })
       │
       ▼
Main thread FSM  ←→  Worker thread (setNoDelay, heartbeats, pre-send)
```

### CDP / custom Chromium (ops)

Runtime `page.evaluateOnNewDocument` patches are detectable. Production should:

1. Build Chromium with CDP strings (`cdc_`) stripped at the Blink C++ layer.
2. Launch via Playwright `executablePath` pointing at the patched binary.
3. Keep `protocolOffload: true` so the browser is only used for challenges.

---

## 2. Provably Fair Analytics & Risk Engine

| Requirement | Module | Status |
|---|---|---|
| Hash chain verification | `src/risk/provably-fair/hash-chain.ts` | DONE |
| Fractional Kelly + λ safety | `src/risk/provably-fair/kelly.ts` | DONE |
| Pareto tail / consecutive-loss probability | `src/risk/provably-fair/kelly.ts` | DONE |
| Volatility cooldown (3σ) | `shouldTriggerVolatilityCooldown()` | DONE |
| Turnover / ultra-low multiplier mode | Config `provablyFair.turnoverMode` + `turnoverTarget` | DONE (config) |

Wire `HashChainVerifier` into the round observer so every published seed is
validated before metrics update. On `PROVABLY_FAIR_BREAK` → HALT.

---

## 3. Latency-Compensated Execution Engine

| Requirement | Module | Status |
|---|---|---|
| Dedicated socket Worker thread | `NativeSocketWorker` | DONE |
| setNoDelay / buffer tuning | Worker socket opts | DONE |
| Application heartbeats | Configurable interval | DONE |
| RTT estimator (hrtime p99) | `RttEstimator` | DONE |
| Pre-send trigger multiplier | `computeTriggerMultiplier()` / `scheduleCashOut()` | DONE |

Formula:

```
M_trigger = max(1.01, target - velocity × (RTT_p99 + safety_ms) / 1000)
```

---

## 4. State Reconciliation & Anti-Countermeasure

| Requirement | Module | Status |
|---|---|---|
| RECONCILING FSM state | Already present; disconnect transitions added | DONE |
| client_order_id pre-flight registry | `ClientOrderIdRegistry` | DONE |
| REST order query reconciliation | `ReconciliationService` | DONE |
| In-payload auto-cashout | Live executor should embed target when API supports it | CONTRACT (call site) |
| Boot reconciliation sequence | Call `reconcile()` on socket re-establish before accepting signals | CONTRACT |

New transitions: any active betting state + `RECONCILE` → `RECONCILING`.

---

## 5. Capital Isolation & Anti-Freeze

| Requirement | Module | Status |
|---|---|---|
| Hot-wallet sweeping | `src/capital/hot-wallet-sweeper.ts` | DONE |
| Synchronous in-memory limits | `src/capital/in-memory-limits.ts` | DONE |
| Out-of-band watchdog (SIGKILL) | `src/capital/watchdog.ts` | DONE |

`InMemoryCapitalGuard.canPlaceBet()` must be called **synchronously** before
any bet payload is constructed. The watchdog runs as a separate process
(`scripts/capital-watchdog.ts` pattern) monitoring `panicBalanceFloor`.

---

## 6. Config surface

All new knobs live under `config.specUpgrade`:

```yaml
specUpgrade:
  ja4:
    enabled: true
    profileId: chrome-126-win11
  nativeSocket:
    enabled: true
    noDelay: true
    safetyMarginMs: 15
    preSendEnabled: true
  payloadIngestion:
    enabled: true
    circuitBreakerThreshold: 8
  provablyFair:
    enabled: true
    kellyLambda: 0.25
    volatilitySigmaThreshold: 3
    turnoverMode: false
  capital:
    enabled: true
    hotBuffer: 5000
    panicBalanceFloor: 500
    maxDrawdownPct: 0.25
    watchdogEnabled: true
  stealth:
    hardwareProfileId: win11-rtx3060-chrome
    biomechanicalInput: true
    protocolOffload: true
```

---

## 7. Integration checklist (composition)

1. On live start: select JA4 + hardware profile, assert cross-stack consistency.
2. Run `captureSession()` after challenges clear.
3. Start `NativeSocketWorker` with transferred headers.
4. Route all WS frames through `parseWsFrame()` + `PayloadCircuitBreaker`.
5. On every bet intent: `ClientOrderIdRegistry.generate()` → embed in payload.
6. Before payload build: `InMemoryCapitalGuard.canPlaceBet(stake)`.
7. Cash-out path: `NativeSocketWorker.scheduleCashOut(...)` when pre-send enabled.
8. On socket close: emit `RECONCILE` → `ReconciliationService.reconcile()`.
9. Hash verifier on every crash result seed.
10. Periodic `HotWalletSweeper.maybeSweep(balance)`.
11. Spawn capital watchdog process when `watchdogEnabled`.

---

## 8. Remaining operational items

- Custom Chromium binary with CDP stripped (build pipeline).
- Real residential proxy quality + sticky sessions (existing ProxyManager).
- Authoritative settlement evidence provider (already required by production hardening).
- Multi-hour soak under live BC.Game with protocol-offload path.
- Platform ToS / house-edge risk remains outside the codebase.

---

## File map (new)

```
src/network/tls/ja4-fingerprint.ts
src/network/tls/native-socket.ts
src/network/tls/index.ts
src/protocol/session-handshake.ts
src/protocol/ws-payload-schemas.ts
src/protocol/index.ts
src/execution/index.ts
src/risk/provably-fair/hash-chain.ts
src/risk/provably-fair/kelly.ts
src/risk/provably-fair/index.ts
src/capital/hot-wallet-sweeper.ts
src/capital/in-memory-limits.ts
src/capital/watchdog.ts
src/capital/index.ts
src/browser/biomechanical-input.ts
src/browser/profiles/immutable-hardware.ts
src/core/reconciliation-service.ts
docs/SPEC_UPGRADE_IMPLEMENTATION.md
```

State machine transitions updated for disconnect → RECONCILING.  
Config schema extended with `SpecUpgradeConfigSchema`.

---

## Integration status (2026-08-21 continued)

| Integration point | Status |
|---|---|
| `LiveBetExecutor` capital guard (sync pre-flight) | DONE |
| `LiveBetExecutor` client_order_id registry | DONE |
| `LiveBetExecutor` biomechanical click path | DONE |
| `wireLiveSession` creates guard/registry/hashVerifier/circuitBreaker | DONE |
| `LiveCashOutExecutor.setNativeSocket` pre-send hook | DONE |
| Config defaults for `specUpgrade` | DONE |
| `scripts/capital-watchdog.ts` | DONE |
| Unit tests (capital, kelly, hash-chain, ws-payload, RTT, reconciliation) | DONE |
| FSM disconnect → RECONCILING transitions | DONE |
| Full protocol-offload path in SessionSupervisor (handshake → native WS) | Helper ready (`wireSpecUpgrade` / `spec-upgrade-wiring.ts`); bind in supervisor when live + protocolOffload |

### Operator commands (new)

```bash
# Capital watchdog (separate process)
TARGET_PID=$(pgrep -f 'node dist/index') PANIC_BALANCE_FLOOR=500 npm run watchdog:capital

# Spec-upgrade unit tests
npm run test:unit:spec
```

---

## Authoritative Settlement (2026-08-21)

| Item | Location |
|------|----------|
| Migration 017 double-entry + orders | `migrations/017_double_entry_settlement.sql` |
| Settlement engine (SERIALIZABLE, idempotent) | `src/settlement/authoritative-settlement-engine.ts` |
| Drift guard | `src/settlement/drift-guard.ts` |
| Evidence provider (null + REST history) | `src/settlement/evidence-provider.ts` |
| Live intent on place | `LiveBetExecutor` → `createOrderIntent` + `markDispatched` |
| Config | `specUpgrade.settlement` |

### Ledger accounts
- `ASSET:CASINO_HOT_WALLET`
- `LIABILITY:UNSETTLED_EXPOSURE`
- `EQUITY:REALIZED_PNL`
- `EXPENSE:CASINO_HOUSE_EDGE`

### Lifecycle
`ORDER_INTENT` → `DISPATCHED` → `PENDING_SETTLEMENT` | `RECONCILING` → `SETTLED_WIN` | `SETTLED_LOSS` | `VOID`

### CDP / Custom Chromium
See `docs/chromium/CUSTOM_CHROMIUM_CDP.md`

### Protocol offload bind
`src/core/protocol-offload-bind.ts` — call after auth + challenge clear.

### HTTP/2 SETTINGS profiles
`src/network/http2/settings.ts`

---

## Settlement close-out wiring (continued)

| Path | Behavior |
|------|----------|
| Cash-out confirmed | `settleOrder(WIN, grossPayout=stake*mult)` |
| Round crash (no cash-out race) | `settleOrder(LOSS, grossPayout=0)` |
| Cash-out/crash race | Bet stays UNKNOWN; reconciler + evidence resolve later |
| client_order_id bind | `ClientOrderIdBound` event → `LiveCashOutExecutor.registerClientOrderId` |
| VOID after deadline | `SettlementReconciler` background worker (15m default) |
| Evidence-first | Reconciler calls `SettlementEvidenceProvider` before VOID |

### Run
```bash
npm run db:migrate   # 017
npm run test:unit:spec
```

---

## Authoritative readers + boot reconcile

| Item | Detail |
|------|--------|
| Readers factory | `src/settlement/authoritative-readers.ts` |
| Wired in | `wireLiveSession` → `confirmationObserver.setAuthoritativeBetReader/CashOutReader` |
| client_order_id maps | Updated via `ClientOrderIdBound` events |
| Boot reconcile | `src/settlement/boot-reconcile.ts` runs before `supervisor.start()` |
| Fail-closed | Without evidence, `requireAuthoritativeConfirmation: true` keeps results unconfirmed |
