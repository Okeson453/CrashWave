# Security Model — Personal-Use BC.Game Crash Automation

For a single-operator bot, the threat model collapses to:
**protect the operator's BC.Game account, Telegram bot token, and the
local machine running the bot.**

## Threats and mitigations

| Threat                                       | Mitigation |
| -------------------------------------------- | ---------- |
| Telegram bot token leaked                    | Stored in `.env` (gitignored). Never logged. Redacted by Pino (`password`, `secret`, `token`, `key` fields). Rotate via @BotFather. |
| BC.Game credentials leaked                   | Never logged. The `/login` conversation is ephemeral; the password is consumed immediately. The resulting session cookie is encrypted with `ENCRYPTION_KEY` (AES-256-GCM, see `src/security/crypto.ts`). Cookie file has 0600 permissions. |
| Operator's Telegram account compromised      | `allowedUserIds` is a strict allowlist; non-allowlisted users get no response (fail-closed). |
| BC.Game detects automation                      | Playwright stealth (`src/browser/stealth.ts`, `src/browser/fingerprint.ts`), optional residential proxy. For personal use with low volume, this is usually sufficient. **There is no 100% guarantee** — see the README disclaimer. |
| Live bet placed by mistake                   | Two-step `/mode live confirm <token>` confirmation (60 s TTL). `/emergencystop` halts immediately. `RiskEngine` enforces daily entries and balance floor. |
| Process crash with live bet pending          | `RecoveryManager.runRecovery()` reconciles UNKNOWN bets on next boot. *(Reintroduced for live mode in a follow-up commit; the dry-run default has no live bets to reconcile.)* |
| DB credentials leaked                        | Use a dedicated DB user with minimal grants (only the `bc_personal` database). |
| Local filesystem accessed                    | `secrets/` directory is chmod 700. `.env` is chmod 600. |
| Telegram API abuse (someone spamming the bot) | Per-user 30/min rate limit (in `src/telegram/router.ts`). |
| Outbound traffic observed by ISP / BC.Game  | Optional proxy via `APP_PROXY__*` env vars (single proxy, no pool/rotation in v1). |

## Operational security

- Run as a dedicated Linux user (e.g., `bc-bot`), not root.
- Docker container runs with `read_only: true` and `cap_drop: ALL` where
  possible. The provided `docker-compose.yml` keeps it simple; harden
  further if your threat model demands it.
- `secrets/` mounted as a tmpfs or read-only volume in production.
- `.env` chmod 600. Never commit `.env`, `secrets/`, or any file matching
  `*.pem`, `*.key`, `credentials*`.
- Update Playwright regularly (`npm i playwright@latest && npx playwright install`).
- Subscribe to BC.Game ToS updates; the operator is responsible for
  compliance. **The bot is provided as-is for personal use; the operator
  assumes all risk.**

## Encryption

The BC.Game session cookie (when set via `/login` for live mode) is
encrypted at rest with AES-256-GCM:

- 32-byte key from `ENCRYPTION_KEY` env var (generate with
  `npm run generate-key`).
- Per-encryption random IV.
- Auth tag stored alongside ciphertext.

Decryption happens only inside the running process when the browser
profile is loaded.

## Logging redaction

The Pino logger is configured with a redaction path that replaces any
log field whose key contains `password`, `secret`, `token`, or `key`
with `[REDACTED]`:

```ts
// src/observability/logger.ts
redact: ['*.password', '*.secret', '*.token', '*.key', '*.apiKey'],
```

In dev (`pino-pretty`) the redaction is also visible; in production
(JSON) it's the same.

## What this bot deliberately does **not** do

- **No remote admin panel.** All control is via the operator's Telegram
  chat.
- **No third-party SaaS.** No telemetry, no remote logging, no error
  reporting, no Sentry / Datadog / Rollbar integrations.
- **No ML model training in the hot path.** ACIE's ensemble is a
  heuristic; the dry-run ledger is the only feedback loop.
- **No public REST API.** The only HTTP listener is `127.0.0.1:9090`
  for `/health` and `/metrics` (or behind a reverse proxy if remote
  monitoring is needed).

## Recovery

If you suspect your bot token or BC.Game credentials are compromised:

1. **Telegram bot token:** Revoke via @BotFather → generate a new one →
   update `.env` → restart.
2. **BC.Game password:** Change it on BC.Game. The encrypted session
   cookie in `secrets/` will no longer be valid; the bot will fail to
   reconnect and prompt you to `/login` again.
3. **`ENCRYPTION_KEY`:** Rotate via `npm run generate-key` → update
   `.env` → restart. The old cookie file will be unreadable; `/login`
   again.
4. **DB credentials:** Rotate the Postgres password and update
   `DATABASE_URL`.

## Disclaimer

> Using automation on BC.Game may violate their Terms of Service and
> result in account ban. This tool is provided as-is for personal
> research and automation. The operator assumes all risk.