# Live Deployment Checklist — Personal-Use BC.Game Crash Automation

A step-by-step checklist for going from zero to a working bot.

## Before you start

- [ ] A BC.Game account you are willing to risk (ToS).
- [ ] A Telegram account, plus a bot token from [@BotFather](https://t.me/BotFather).
- [ ] Your Telegram numeric user ID (DM [@userinfobot](https://t.me/userinfobot) or check via `getUpdates`).
- [ ] A Linux VPS or local machine (Chromium needs ~512 MB RAM).
- [ ] PostgreSQL 13+ (15+ if you want TimescaleDB).

## 1. Install

```bash
git clone <your-fork-url>/personal-bc-automation.git
cd personal-bc-automation
npm ci
npx playwright install chromium
```

## 2. Configure

```bash
cp .env.example .env
$EDITOR .env

# Required:
TELEGRAM_BOT_TOKEN=<from @BotFather>
APP_TELEGRAM__ALLOWED_USER_IDS=[<your numeric user ID>]
DATABASE_URL=postgresql://user:pass@localhost:5432/bc_personal

# Generate the encryption key
npm run generate-key
# Paste the printed 32-byte hex into .env as ENCRYPTION_KEY=
```

The default `config.yaml` is fine for a dry-run. Override any of:
`system.mode`, `betting.stakePerEntry`, `betting.cashOutTarget`,
`dryRun.*`, `risk.*` if you want different defaults.

## 3. Database

```bash
docker compose up -d postgres
# or: pg_ctl / systemctl start postgresql

npm run db:migrate
```

Verify the migrations ran:
```bash
psql $DATABASE_URL -c '\dt'
# Should list: sessions, rounds, bets, predictions, audit_events,
#              daily_stats, balance_snapshots, ticks
```

## 4. Boot

```bash
npm start
# or: npm run dev  (live reload)
```

In another terminal, confirm the bot is up:
```bash
curl -sf http://localhost:9090/health
# {"status":"ok","mode":"dry-run"}
```

In Telegram, DM your bot:
```
/start
```

You should see the welcome message.

## 5. Dry-run validation (24 h minimum)

Leave it running for at least 24 hours in dry-run. While it runs:

- [ ] `/status` shows mode = `dry-run`, all green.
- [ ] `/health` shows DB healthy, Telegram polling, workers running.
- [ ] `/analytics` shows predictions flowing; expected value (EV) trends
      positive on your chosen target.
- [ ] `/pnl` shows the virtual ledger converging (or at least
      non-diverging).
- [ ] `/daily` shows reasonable daily trade counts and win rate.
- [ ] No `/emergencystop` or `/sheath` triggers (other than your own
      manual tests).

## 6. Failover checks

- [ ] `/sheath` → confirms betting paused; observation continues.
- [ ] `/unsheath` → resumes.
- [ ] `/emergencystop` → halts everything; `/status` shows halted.
- [ ] `/stop` → graceful shutdown; `/status` in Telegram still works
      after restart.
- [ ] `/config set stakePerEntry 100` → returns token.
- [ ] `/config confirm <token>` → applies.
- [ ] Kill the process (`Ctrl+C` or `docker compose stop app`) → restart
      → state recovers (in dry-run this is a no-op; in live it should
      reconcile any UNKNOWN bets).

## 7. Going live

⚠️  Only proceed if the dry-run validation passes AND you've read
`docs/security-model.md` and `README.md`.

### 7a. Login

```
/login
```
The bot will ask for your BC.Game email, then password. After the
browser launches and authenticates, you'll get a confirmation. The
encrypted session cookie is stored in `./secrets/browser-profile/`.

If login fails, retry. Common causes:
- Wrong credentials.
- BC.Game requiring 2FA (the bot does not yet support 2FA — disable
  2FA or use a separate account).
- Stealth detection (try `BROWSER_HEADLESS=false` to see what's
  happening).

### 7b. Two-step live mode

```
/mode live                (bot replies with an 8-char token, 60 s TTL)
/mode confirm XXXXXXXX    (within 60 s, bot confirms LIVE MODE ACTIVATED)
```

If `/login` has not completed, the bot will refuse with a clear error.

### 7c. Verify

- [ ] `/status` shows mode = `live`, balance tracker reading BC.Game.
- [ ] `/balance` shows real BC.Game balance.
- [ ] `/lastround` shows the most recent round.
- [ ] `/analytics` shows real (not virtual) P&L.
- [ ] Drawdown is below your risk threshold.

## 8. Day-to-day operation

- **Start of day:** `/status` and `/health`.
- **Throughout the day:** `/pnl`, `/balance` to watch the bot's
  performance. If anything looks off, `/pause` and investigate.
- **End of day:** `/analytics` to review signal quality; wait for the
  scheduled daily report (if enabled).
- **If something goes wrong:** `/emergencystop` first, then investigate.

## 9. Backups

- `secrets/` — back up if you want to skip `/login` next time.
- Postgres data volume — back up weekly (`pg_dump`).
- `config.yaml` — version-controlled in your private git repo.

## 10. Rollback

If you need to stop:

```bash
/mode maintenance   # bot stops automated activity but stays responsive
/emergencystop       # force-halt (requires /resume to recover)
```

To fully stop the process:
```bash
docker compose stop app
# or: Ctrl+C in the foreground terminal
```

## 11. Upgrade

```bash
git pull
npm ci
npm run db:migrate       # if migrations changed
npm run build
# restart via your process manager (Docker, systemd, pm2)
```

Always read the changelog before upgrading; the Telegram command surface
is stable, but config schema may add new optional fields.