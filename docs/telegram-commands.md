# Telegram Commands

Complete reference for all Telegram bot commands available to authorized operators.

## Authentication

All commands require the operator's Telegram user ID to be in the `allowedUserIds` allowlist. Unauthorized users receive no response.

## Command Reference

### `/start`
Initialize interaction with the bot. Displays welcome message and current system status.

**Response:**
```
BC.Game Crash Automation Bot
Status: Running (Observe-Only)
Session: sess-abc123
Rounds Today: 45
P&L Today: +$210
```

### `/status`
Display comprehensive system status.

**Response:**
```
System Status
=============
Mode: live
State: observing
Browser: up
Database: up
Redis: up
Rounds Observed: 128
Ticks Recorded: 4,521
Daily Entries: 23/100
Daily P&L: +$630
Current Balance: $5,430
Consecutive Losses: 2
Drawdown: 3.2%
```

### `/mode <mode>`
Transition the system to a different operating mode.

**Modes:**
- `observe-only` - Watch and record only, no bets
- `dry-run` - Simulate bets without real money
- `live` - Place real bets (requires confirmation)

**Example:**
```
/mode dry-run
```

**Response:**
```
Mode transition: observe-only -> dry-run
Dry-run validation required before live mode.
```

### `/pause`
Pause the system. Halts all betting but continues observation.

**Response:**
```
System paused.
Current round will complete.
No new bets will be placed.
```

### `/resume`
Resume the system from paused state.

**Response:**
```
System resumed.
Mode: live
```

### `/emergency-stop`
Trigger emergency stop. Halts all executors immediately.

**Response:**
```
EMERGENCY STOP TRIGGERED
All betting halted immediately.
Pending bets cancelled.
State preserved.

Use /emergency-reset to resume (after review).
```

### `/emergency-reset`
Reset emergency stop after operator review.

**Requires:** All UNKNOWN bets must be resolved.

**Response:**
```
Emergency stop reset.
System returning to paused state.
Use /resume to continue.
```

### `/balance`
Display current balance and recent changes.

**Response:**
```
Balance: $5,430.00
Last Update: 2026-08-18 14:32:05 UTC
24h Change: +$210.00
7d Change: +$1,470.00
```

### `/pnl`
Display profit and loss summary.

**Response:**
```
P&L Summary
===========
Today: +$630 (9 wins, 3 losses)
Hit Rate: 75.0%
Break-even: 76.9%
Net P&L: -$210 (below break-even)

Last 10 bets:
Win  $210  @ 1.45x
Win  $210  @ 1.38x
Loss -$700 @ 1.12x
...
```

### `/entries`
Display daily entry usage.

**Response:**
```
Daily Entries: 23/100
Remaining: 77
Reset: 2026-08-19 00:00:00 UTC
Utilization: 23%
```

### `/config`
Display current betting configuration.

**Response:**
```
Current Configuration
=====================
Stake: $700
Cash-out Target: 1.30x
Max Daily Entries: 100
Min Balance: $1,000
Max Drawdown: 50%
Consecutive Loss Threshold: 10
```

### `/set-stake <amount>`
Update the bet stake amount.

**Validation:**
- Must be positive integer
- Must not exceed balance
- Must be >= 100

**Example:**
```
/set-stake 500
```

**Response:**
```
Stake updated: $700 -> $500
New break-even hit rate: 75.0%
```

### `/set-target <multiplier>`
Update the cash-out target multiplier.

**Validation:**
- Must be >= 1.01
- Recommended: 1.20 - 2.00

**Example:**
```
/set-target 1.50
```

**Response:**
```
Target updated: 1.30x -> 1.50x
New break-even hit rate: 66.7%
```

### `/resolve-bet <bet-id> <state> <pnl>`
Manually resolve an UNKNOWN bet.

**States:** `CASHED_OUT`, `LOST`, `RECONCILED`

**Example:**
```
/resolve-bet bet-abc123 LOST -700
```

**Response:**
```
Bet bet-abc123 resolved to LOST
P&L: -$700
```

### `/recovery`
Trigger manual recovery sweep.

**Response:**
```
Recovery sweep started...
Unknown bets: 3
Resolved: 3
Manual review required: 0
System can resume: YES
```

### `/health`
Display component health status.

**Response:**
```
Component Health
================
Browser:     OK  (heap: 245MB)
Database:    OK  (latency: 12ms)
Redis:       OK  (latency: 2ms)
Telegram:    OK  (queue: 0)
Game Adapter: OK (source: dom)
Observer:    OK  (confidence: high)
```

### `/logs <lines>`
Retrieve recent log lines.

**Example:**
```
/logs 20
```

**Response:**
```
[2026-08-18 14:30:01] Round started: round-789
[2026-08-18 14:30:05] Bet placed: bet-456 (stake: $700)
...
```

### `/ping`
Test bot responsiveness.

**Response:**
```
pong
Latency: 45ms
```

### `/help`
Display help message with available commands.

**Response:**
```
Available Commands:
/status          - System status
/mode <mode>     - Change mode
/pause           - Pause system
/resume          - Resume system
/emergency-stop  - Emergency stop
/balance         - Show balance
/pnl             - Show P&L
/entries         - Show entry usage
/config          - Show configuration
/set-stake       - Update stake
/set-target      - Update target
/resolve-bet     - Resolve unknown bet
/recovery        - Run recovery
/health          - Component health
/logs            - Recent logs
/ping            - Test bot
/help            - This message
```

## Command Aliases

For convenience, the following aliases are supported:

| Alias | Command |
|-------|---------|
| `/s` | `/status` |
| `/b` | `/balance` |
| `/p` | `/pnl` |
| `/e` | `/entries` |
| `/h` | `/health` |
| `/stop` | `/emergency-stop` |

## Rate Limiting

Commands are rate-limited to 30 messages per minute per operator. Excessive commands will receive:
```
Rate limit exceeded. Please wait before sending more commands.
```

---

## Multi-Tenant Platform Bot (PLATFORM_MODE=control-plane)

Authentication uses `ADMIN_TELEGRAM_ID` for elevated privileges. Regular users are resolved by `chat_id → users.telegram_id`.

### User Commands

| Command | Description |
|---------|-------------|
| `/start` | Register / welcome |
| `/status` | Engine status, plan, P&L |
| `/pause` / `/resume` | Pause or resume own engine |
| `/mode <observe-only\|dry-run\|live>` | Switch mode |
| `/subscribe` | Plan selection |
| `/setup_creds` | Guided BC.Game credential entry |
| `/stake` / `/stake_set <n>` | View / set stake (Pro/Whale) |
| `/pay_stake_increase` | Pay stake-increase fee |
| `/today` | Daily access (pay-as-you-go) |
| `/upgrade` | Upgrade plan |
| `/auto_renew` | Toggle auto-renew |
| `/history [n]` | Last N bets (default 10) |
| `/analytics` | Personal performance summary |
| `/support <message>` | Open support ticket (notifies admin) |

### Admin Commands (`ADMIN_TELEGRAM_ID` only)

| Command | Description |
|---------|-------------|
| `/admin_users` | List users, plans, engine status |
| `/admin_user <user_id>` | Deep dive: plan, stake, P&L, engine, trends |
| `/admin_stats` | Platform-wide users, engines, P&L |
| `/admin_leaderboard` | Top 10 by P&L |
| `/admin_losers` | Users with negative P&L |
| `/admin_inactive` | Active users with no bets in 24h |
| `/admin_bets <user_id> [n]` | Recent bets for a user |
| `/admin_health` | Engine status counts + health sweep |
| `/admin_create_user <telegram_id>` | Create user + plan picker |
| `/admin_set_creds <user_id> <user> <pass> [2fa]` | Encrypt & store credentials |
| `/admin_set_stake <user_id> <amount>` | Override stake (marks fee paid) |
| `/admin_set_mode <user_id> <mode>` | Set observe/dry-run/live |
| `/admin_start_engine <user_id> [mode]` | Provision and start engine |
| `/admin_pause_engine <user_id>` | Pause one engine |
| `/admin_destroy_engine <user_id>` | Destroy engine |
| `/admin_pause_all` / `/admin_resume_all` | Global pause/resume |
| `/admin_ban <telegram_id>` | Ban user, destroy engine, purge creds |
| `/admin_user_stake <user_id>` | Stake config + history |
| `/admin_high_stakes` | Users above stake threshold |
| `/admin_broadcast <msg>` | Message all active users |
| `/admin_pending_payments` | List pending payment transactions |
| `/admin_verify <tx_id>` | Manually verify a payment |

Admin is the same bot: middleware sets `isAdmin` when `chat.id === ADMIN_TELEGRAM_ID`. Admin may also subscribe and run a personal engine on the same Telegram ID.
