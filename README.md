# Personal-Use BC.Game Crash Automation

A **single-operator**, Telegram-controlled automation tool for BC.Game's
Crash game. Defaults to `dry-run` with a virtual ledger; live mode is a
deliberately loud, two-step, audited opt-in.

> **Risk:** Using automation on BC.Game may violate their Terms of Service and
> result in account ban. This tool is provided as-is for personal research
> and automation. The operator assumes all risk.

## Quickstart

```bash
npm ci
npx playwright install chromium
cp .env.example .env
$EDITOR .env                       # set TELEGRAM_BOT_TOKEN, APP_TELEGRAM__ALLOWED_USER_IDS, DATABASE_URL, ENCRYPTION_KEY
cp config.example.yaml config.yaml  # or just edit the existing config.yaml
npm run generate-key               # paste into ENCRYPTION_KEY
docker compose up -d postgres      # or use a system Postgres
npm run db:migrate
npm start                          # or `npm run dev` for live reload
```

In Telegram, message your bot:

```
/start         # welcome + status
/status        # verify everything is green
/mode dry-run  # default; can start in dry-run to see signals
/analytics     # after a few minutes, you should see predictions flowing
```

## Modes

| Mode           | What runs                                                     | What writes to balance     |
| -------------- | ------------------------------------------------------------- | -------------------------- |
| `observe-only` | GameAdapter → Observer → Persistence (rounds + ticks)         | Nothing                    |
| `dry-run` (default) | observe + PredictionEngine → DecisionEngine → DryRunController (virtual ledger) | Virtual ledger only        |
| `live`         | dry-run flow + LiveExecutor (browser bet + cash-out)          | Real BC.Game account       |
| `maintenance`  | Nothing automated; commands only                              | Nothing                    |

### Going live (two-step, audited)

```
/mode live              (bot replies with an 8-char token, 60s TTL)
/mode confirm XXXXXXXX  (within 60s, bot confirms "LIVE MODE ACTIVATED")
```

If `/login` has not been completed, the bot will refuse to enter live mode.

## Commands

Full reference: `docs/telegram-commands.md`.

| Command | Purpose |
| --- | --- |
| `/start` `/menu` `/help` | Welcome + menu |
| `/login` `/login_cancel` | BC.Game email/password (live only) |
| `/status` `/health` `/lastround` | Live status |
| `/balance` `/pnl` `/daily` `/entries` `/session` | Ledger & P&L |
| `/pause` `/resume` `/stop` `/emergencystop` | Lifecycle control |
| `/mode` `/sheath` `/unsheath` | Mode & safety |
| `/config` `/analytics` | Tuning & signal stats |

## Architecture

Single Node.js process:

1. Boots: logger, DB pool, metrics HTTP (`:9090`), Telegram bot, worker fleet.
2. `Orchestrator` runs the `GameAdapter` (Playwright) → `RoundObserver` →
   `EventBus`.
3. `PredictionEngine` produces a signal per round; `DecisionEngine` decides
   ENTER / REJECT / SHEATH / MONITOR.
4. In `dry-run`, `DryRunController` opens a virtual trade in the
   `VirtualLedger`; on `RoundCrashed` it resolves WIN/LOSS.
5. In `live`, `LiveExecutor` clicks the bet/cash-out buttons in BC.Game.
6. Workers (analytics, learning, settlement, risk, validation, regime) run
   fire-and-forget background jobs.

See `docs/architecture.md` for the full diagram.

## Configuration

Two files:

- `config.yaml` — personal-use config (system, betting, dryRun, risk,
  observation, telegram, browser, persistence, health, proxy).
- `.env` — secrets and runtime env vars (TELEGRAM_BOT_TOKEN, DATABASE_URL,
  ENCRYPTION_KEY, etc.).

## Deployment

Single Docker image (Playwright base), single Postgres container. See
`docker-compose.yml`.

```bash
docker compose up -d --build
docker compose logs -f app
```

## Validation checklist before `/mode live`

1. ✅ Run in `dry-run` for at least 24 hours.
2. ✅ Verify `/health` shows all green.
3. ✅ Verify `/analytics` shows positive expected value (EV > 0).
4. ✅ Verify `/pnl` is positive (or at least non-diverging).
5. ✅ Verify drawdown is below your risk threshold.
6. ✅ Back up the `secrets/` directory.
7. ✅ Test `/emergencystop`, `/sheath`, `/unsheath`.
8. ✅ Then and only then: `/mode live` → confirm token.

## Security

See `docs/security-model.md`. Highlights:

- Telegram bot is owner-only (`allowedUserIds` allowlist).
- `ENCRYPTION_KEY` (AES-256-GCM) encrypts the BC.Game cookie at rest.
- Process runs as a dedicated user with `read_only: true`, `cap_drop: ALL`
  in Docker.
- Sensitive keys (`password`, `secret`, `token`, `key`) are redacted by
  Pino.

## Repository layout

```
src/
├── index.ts                  # 3-line dispatcher
├── app/composition.ts        # personal-use composition root
├── core/                     # orchestrator, dry-run, event-bus, state-machine, sheath, recovery
├── game/                     # game adapter (DOM + WS) + observer
├── browser/                  # Playwright stealth + login + evasion (gated by stealthLevel)
├── prediction/               # ACIE feature engine, regime detector, ensemble, models
├── decision/                 # decision engine + opportunity ranker
├── betting/                  # mode gate, executor, risk engine, idempotency
├── ledger/                   # balance tracker, daily entries, P&L, virtual ledger
├── telegram/                 # gateway + router + 22 commands (sole operator UI)
├── workers/                  # 6-worker fleet (analytics, learning, settlement, risk, validation, regime)
├── observability/            # logger, health monitor, metrics, performance
├── persistence/              # pg pool, repositories, migrations
├── config/                   # schema, loader, defaults, validator
└── utils/                    # crash handler, retry, day boundary, etc.
```

## License

UNLICENSED — private use only.