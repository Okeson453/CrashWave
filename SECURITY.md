# Security Model — Personal-Use BC.Game Crash Automation

**Status:** Personal use, single operator, no multi-tenancy.
**Version:** v1.0.0-personal
**Source-of-truth:** `docs/security-model.md` is the comprehensive document;
this file is the summary.

The personal-use refactor collapses the security model to one job:
**protect the operator's BC.Game account and Telegram bot token.**

## Threat Model

| Asset | Threat | Mitigation |
|---|---|---|
| Telegram bot token | Token leaked from `.env` / logs / git | Stored only in `.env` (gitignored); `pino` redaction list excludes token-shaped fields; rotate via @BotFather. |
| BC.Game session cookie | Cookie exfiltrated from disk | AES-256-GCM at rest via `src/security/crypto.ts`; `secrets/` chmod 700; never written to logs. |
| BC.Game credentials | `/login` conversation captured by Telegram side-channel | Conversation is ephemeral in memory; password is never stored; cookie is the only persistent secret. |
| Operator's Telegram account | Compromised phone → bot access | `allowedUserIds` is a strict numeric allowlist in `config.yaml: telegram.allowedUserIds` (also settable via `APP_TELEGRAM__ALLOWED_USER_IDS`). Non-allowlisted users get no response, no error, no log. |
| Live-mode accidental bet | Operator fat-fingers `/mode live` | Two-step confirmation: `/mode live` issues an 8-char token (60s TTL) → `/mode confirm <token>` activates. Every transition is audit-logged with the operator ID. |
| Stuck live bet on process crash | SIGKILL with live bet pending | `RecoveryManager.runRecovery()` reconciles UNKNOWN bets on next boot (spec §7.2). |
| DB credentials leaked | Plain `DATABASE_URL` exposed | Use a dedicated Postgres user with minimal grants (`SELECT, INSERT, UPDATE, DELETE` only on the `crash` schema, no `CREATE`, no superuser). |
| Local filesystem read by another user | `secrets/` readable by other local users | `chmod 700 secrets/` at install. Docker compose mounts it as a tmpfs or read-only volume. |
| Telegram API abuse (spam) | Someone sends 1000 messages to the bot | Per-user 30/min rate limit in `telegram/router.ts` + per-message throttle in `telegram/gateway.ts`. |
| BC.Game detects automation | Site fingerprint catches Playwright | Stealth layer (`src/browser/evasion/*`), humanized input (`src/browser/humanize.ts`), optional residential proxy (`config.proxy`). The full browser pipeline is deferred for personal use (see `docs/security-model.md` for the live-mode threat surface). |

## Operational Security

- Run as a dedicated Linux user (e.g., `bc-bot`), not root.
- Docker container runs with `read_only: true` and `cap_drop: ALL`.
- `.env` chmod 600.
- `secrets/` chmod 700.
- No `bcgame_2fa_secret`, `bcgame_password`, etc. ever committed to git (gitignored via `secrets/`).
- Update Playwright regularly: `npm i playwright@latest && npx playwright install`.
- Subscribe to BC.Game ToS updates; the operator is responsible for compliance.

## What We Deliberately Don't Do

- **No remote admin panel.** All control is via the operator's Telegram chat.
- **No third-party SaaS.** No telemetry, no remote logging, no error reporting.
- **No ML model training in the hot path.** Training is offline (if at all); live path is heuristic only.
- **No public REST API.** The only HTTP listener is `127.0.0.1:9090` for `/health`, `/state`, `/metrics` (or behind a reverse proxy if remote monitoring is needed).
- **No multi-tenant isolation.** A single operator is the only trusted entity.

## Incident Response

If you suspect your bot token is compromised:
1. Revoke the token via @BotFather (`/revoke`).
2. Update `.env` with a new token.
3. Restart the bot.
4. The new token is the only thing the bot needs; the BC.Game session cookie is independent.

If you suspect your BC.Game session is compromised:
1. From the Telegram bot: `/emergencystop` — halts all activity.
2. From BC.Game: log out of the session, rotate your password, enable 2FA.
3. Delete the `secrets/browser-profile/` directory; the next `/login` will create a fresh encrypted session.

## Audit Trail

Every mode change, every pause/resume/stop, every emergency stop, every
config change with `set/confirm` is logged with `{ operatorId, action,
timestamp }` via `pino`. The log is the source of truth for forensic
analysis.
