# Architecture — Personal-Use BC.Game Crash Automation

A single Node.js process that boots, watches BC.Game's Crash game, runs ACIE
predictions, and (in dry-run by default) simulates every signal against a
virtual ledger — all driven by a Telegram bot.

## 1. Single-process runtime

```
┌────────────────────────────────────────────────────────────────┐
│                        index.ts                                 │
│  1. Load config (config.yaml + .env)                           │
│  2. Boot logger, DB pool                                       │
│  3. composeApplication(config)                                 │
│  4. /health + /metrics HTTP listener on PORT                   │
│  5. SIGTERM/SIGINT → graceful shutdown                         │
└────────────────────────────────────────────────────────────────┘
```

The single process holds:

- The Telegram bot (long-polling loop) — only if `TELEGRAM_BOT_TOKEN` is set.
- The PostgreSQL connection pool.
- The `Orchestrator` event loop (drives `GameAdapter` → `RoundObserver` → DB).
- A 6-worker fleet (analytics, learning, settlement, risk, validation, regime).
- The metrics HTTP server on `PORT`/`METRICS_PORT` (default 9090).

## 2. Component diagram (post-refactor)

```
                ┌────────────────────────────┐
                │      Telegram Bot          │
                │  (operator's chat only)    │
                └──────────────┬─────────────┘
                               │ commands
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                       CommandRouter                              │
│  /start /help /status /balance /pnl /daily                       │
│  /pause /resume /stop /emergencystop /mode                       │
│  /sheath /unsheath /config                                       │
└──────────────┬─────────────────────────────────┬─────────────────┘
               │                                 │
   (control: pause, mode, config)     (queries: status, pnl, daily)
               ▼                                 ▼
┌─────────────────────────┐         ┌─────────────────────────────┐
│  Orchestrator           │         │  In-memory Stats            │
│  + DryRunController     │         │  + Virtual Ledger           │
│  + VirtualLedger        │         │  (DailyEntry, P&L)          │
└──────────────┬──────────┘         └─────────────────────────────┘
               │
               │  events: RoundStarted, RoundCrashed, MultiplierUpdated
               ▼
┌─────────────────────────┐    ┌──────────────────────────────────┐
│  GameAdapter            │    │  WorkerFleet (6 workers)         │
│  + RoundObserver        │    │  • analytics                     │
│  (Playwright page)      │    │  • learning                      │
└──────────────┬──────────┘    │  • settlement                    │
               │                │  • risk                          │
               │ every 200ms    │  • validation                    │
               ▼                │  • regime                        │
        ┌──────────────┐         └──────────────────────────────────┘
        │ BC.Game      │
        │ Crash page   │
        │ (Chromium)   │
        └──────────────┘
```

## 3. Mode semantics

| Mode           | What runs                                                     | What writes to balance     |
| -------------- | ------------------------------------------------------------- | -------------------------- |
| `observe-only` | GameAdapter → Observer → Persistence (rounds + ticks)         | Nothing                    |
| `dry-run` (default) | observe + PredictionEngine → DecisionEngine → DryRunController (virtual ledger) | Virtual ledger only        |
| `live`         | dry-run flow + LiveExecutor (browser bet + cash-out)          | Real BC.Game account       |
| `maintenance`  | Nothing automated; commands only                              | Nothing                    |

The mode is set at startup via `APP_SYSTEM__MODE` env var or
`config.yaml:system.mode`, and can be changed at runtime via `/mode <m>`
(with the 2-step confirmation for `live`).

## 4. One round, one decision (dry-run)

```
RoundStarted(roundId)
   ↓
RoundObserver publishes event
   ↓
Orchestrator emits 'RoundStarted' on EventBus
   ↓
Hot handlers (in-process):
   1. prediction: build feature vector, run ensemble, emit PredictionSignal
   2. decision:   score, threshold, return DecisionRecord
   3. dry-run:    if decision === ENTER, controller.openTrade()
                  → ledger.openTrade()
   ↓
GameAdapter polls DOM every 200ms, emits MultiplierUpdated events
   ↓
Orchestrator persists ticks (Postgres / TimescaleDB)
   ↓
RoundCrashed(roundId, crashPoint)
   ↓
Hot handlers:
   1. dry-run:    controller.onRoundCompleted(roundId, crashPoint)
                  → ledger.resolveRound() → WIN/LOSS
   2. settlement:  update bet status, compute P&L
   3. learning:    record (signal, outcome) tuple
   4. analytics:   roll up daily stats
   5. validation:  compare predicted vs actual
   6. risk:        check drawdown, trigger sheath if needed
```

## 5. Persistence

- **PostgreSQL 15+** (TimescaleDB extension optional for tick compression).
- Tables used: `sessions`, `rounds`, `bets`, `predictions`, `audit_events`,
  `daily_stats`, `balance_snapshots`, `ticks` (hypertable if TimescaleDB
  available).
- Redis is **optional**. If provided, it backs the rate-limit window.
  Without it, an in-memory token bucket is used.
- Migrations live in `migrations/` and are run by
  `npm run db:migrate`. Personal-use migrations: `001`–`007`. Deprecated
  tenant/billing migrations are in `migrations/_deprecated/` for history.

## 6. Startup sequence

```
[Idle]
   │ npm start
   ▼
[Loading config]      ──fail──▶  [Crash: invalid config]
   │
   ▼
[Connecting DB]       ──fail──▶  [Crash: DATABASE_URL unreachable]
   │
   ▼
[Building composition] (logger, repos, decision engine, dry-run, telegram, workers)
   │
   ▼
[Starting metrics server (:9090)]
   │
   ▼
[Starting Telegram bot (polling)]   (only if TELEGRAM_BOT_TOKEN set)
   │
   ▼
[Starting workers (6)]
   │
   ▼
[Running]  ──SIGTERM──▶  [Graceful shutdown]
                              │ stop workers
                              │ stop telegram bot
                              │ close DB
                              │ exit 0
```

## 7. Why no other layers?

There is no:

- **No multi-tenant platform.** Single operator, single Telegram chat.
- **No billing.** No Stripe, no Paystack, no subscriptions.
- **No admin dashboard.** The Telegram bot is the only UI.
- **No public REST API.** The only HTTP listener is the private
  `/health` + `/metrics` on `127.0.0.1:9090`.
- **No multi-process locks.** Single process; no Redis polling-lock,
  no instance-lock.
- **No outbox publisher.** The event bus is in-memory only.
- **No tracing.** OTel removed.

A deleted file is a file that can't break.