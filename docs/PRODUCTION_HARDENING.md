# Production hardening implemented

This release hardens the execution/financial boundary in five areas.

## 1. UNKNOWN is evidence-driven

Round crash history is observation only. An UNKNOWN bet cannot be resolved to CASHED_OUT, LOST, or FAILED unless an `SettlementEvidenceProvider` supplies authoritative external settlement evidence.

Implement the provider for the target platform and pass it as the fourth argument to `UnknownStateRecovery`.

Required evidence for a cash-out should include the external bet/transaction reference and the server-confirmed multiplier. A crash point at or above the target is never sufficient by itself.

## 2. Cash-out confirmation fails closed

`ConfirmationObserver` now defaults to `requireAuthoritativeConfirmation: true`.

DOM and WebSocket signals are observations, not settlement proof. Live wiring must call `setAuthoritativeCashOutReader()` and `setAuthoritativeBetReader()` with readers backed by an authoritative platform API/history source.

If no authoritative reader is configured, the live executor will leave the action UNKNOWN rather than fabricate a successful settlement.

## 3. Financial ledger + outbox

Migrations 013-015 add:

- append-only `financial_ledger_events`
- transactional `event_outbox`
- database-enforced bet transition rules
- durable outbox claiming/publication
- tenant-scoped RLS for financial records

Bet creation and state changes write the financial evidence and outbox entry in the same PostgreSQL transaction as the bet mutation.

## 4. Tenant context

PostgreSQL session GUCs are connection-local. The old startup helper no longer writes tenant context to an arbitrary pooled connection.

Engine mode now requires `TENANT_ID`. Pool connections initialize their tenant/security context, while `withTenantContext()` provides transaction-scoped `SET LOCAL` defense in depth.

Tenant RLS policies fail closed and tenant-owned writes require an explicit matching tenant context.

## 5. Crash/cash-out race

A round crash arriving while `CASH_OUT_REQUESTED` or a cash-out confirmation is in progress now moves the bet to UNKNOWN instead of LOST. This prevents a late server-side cash-out from being overwritten by a local crash observation.

## Required deployment sequence

1. Run all migrations through 016.
2. Set `TENANT_ID` for every engine process.
3. Wire authoritative placement and cash-out readers.
4. Run integration/chaos tests against real PostgreSQL and Redis.
5. Verify zero UNKNOWN bets before enabling live execution.
6. Verify the outbox publisher is running and draining pending events.

The implementation intentionally fails closed when authoritative settlement evidence is unavailable.
