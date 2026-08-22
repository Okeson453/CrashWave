# Architecture Documentation

## Overview

The BC.Game Crash Automation & Analytics System is a Node.js/TypeScript application that automates observation and betting on the BC.Game Crash game. It uses Playwright for browser automation, PostgreSQL/TimescaleDB for persistence, Redis for distributed coordination, and Telegram for operator notifications.

## System Architecture

```
+-------------------+     +-------------------+     +-------------------+
|   Telegram Bot    |<--->|   Core Services   |<--->|   PostgreSQL      |
|  (Operator UI)    |     |  (Event Bus,      |     |  (Sessions,       |
+-------------------+     |   State Machine,  |     |   Rounds, Bets,   |
                          |   Orchestrator)   |     |   Ticks, Audit)   |
+-------------------+     +-------------------+     +-------------------+
|   Redis           |              |
|  (Mutex, Cache)   |              v
+-------------------+     +-------------------+     +-------------------+
                          |   Betting Layer   |     |   Analytics       |
                          |  (Risk Engine,    |     |  (Hit Rate,       |
                          |   Executors,      |     |   P&L, Drawdown)  |
                          |   Safeguards)     |     +-------------------+
                          +-------------------+
                                   |
                                   v
                          +-------------------+
                          |   Browser Layer   |
                          |  (Playwright,     |
                          |   Game Adapter,   |
                          |   Round Observer) |
                          +-------------------+
                                   |
                                   v
                          +-------------------+
                          |   BC.Game Crash   |
                          |   (Web UI)        |
                          +-------------------+
```

## Core Components

### Event Bus
The Event Bus is the central nervous system of the application. All components communicate through typed events:
- `GameLoaded` - Browser has loaded the game
- `RoundStarted` - New round detected
- `MultiplierUpdated` - Tick recorded
- `RoundCrashed` - Round ended with crash point
- `BetPlaced` - Bet placement confirmed
- `BetCashOut` - Cash-out confirmed
- `SystemPaused` - System entered paused state
- `SystemResumed` - System resumed operation
- `CriticalError` - Unrecoverable error occurred

### State Machine
The state machine manages the lifecycle of bets through states:
```
RESERVED -> REQUESTED -> PENDING -> ACTIVE -> CASHED_OUT
                                      |
                                      +-> LOST
                                      |
                                      +-> FAILED
                                      |
                                      +-> UNKNOWN (recovery needed)
```

### Orchestrator
The Orchestrator wires together all components and manages the main observation loop. It:
1. Starts the browser and navigates to the game
2. Initializes the game adapter and round observer
3. Subscribes to round events
4. Persists round data and ticks
5. Emits system events

### Session Supervisor
Manages the full session lifecycle:
- Browser launch and profile management
- Authentication and session restoration
- Game navigation
- Health monitoring
- Recovery from failures

## Data Flow

### Observation Flow
1. Browser loads BC.Game Crash
2. GameAdapter polls DOM for multiplier updates
3. RoundObserver detects round transitions
4. Orchestrator persists rounds and ticks
5. Analytics engine computes metrics

### Betting Flow
1. RiskEngine evaluates entry conditions
2. DailyEntryLedger reserves an entry slot
3. LiveBetExecutor places bet via DOM interaction
4. ConfirmationObserver verifies bet placement
5. Bet state transitions through the state machine
6. On round crash, P&L is calculated and recorded

### Recovery Flow
1. On startup, RecoveryManager checks for UNKNOWN bets
2. UnknownStateRecovery queries round history
3. Heuristics resolve bets (LOST/RECONCILED)
4. BalanceReconciliation verifies ledger consistency
5. System resumes if all conditions are met

## Persistence Layer

### PostgreSQL/TimescaleDB
- **sessions** - Session records with mode and status
- **rounds** - Round data with crash points
- **ticks** - Time-series multiplier data (TimescaleDB hypertable)
- **bets** - Bet records with full state history
- **audit_events** - Immutable audit trail

### Redis
- Distributed mutex for bet placement coordination
- Configuration cache
- Session state cache

## Security Model

See [security-model.md](security-model.md) for full details.

Key principles:
- No secrets in logs
- Encrypted profiles at rest
- Telegram allowlist enforcement
- Complete audit trail
- Dry-run validation before live mode

## Performance Characteristics

- Tick observation latency: P99 < 500ms (target)
- Bet placement latency: P95 < 2000ms
- Database writes: ~100 ticks/round, 1 round every 3-10s
- Memory: Browser heap monitored, alert at 512MB

## Deployment Architecture

```
+---------------------+
|   Docker Compose    |
|  - App Container    |
|  - Postgres Container|
|  - Redis Container  |
|  - Grafana Container|
|  - Prometheus Cont. |
+---------------------+
```

See [live-deployment-checklist.md](live-deployment-checklist.md) for deployment procedures.
