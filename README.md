# BC.Game Crash Automation & Analytics System

A production-grade TypeScript/Node.js automation and analytics platform for observing and participating in BC.Game Crash rounds under a deterministic betting policy.

## Core Operating Policy

| Parameter | Value | Mutability |
|---|---|---|
| Stake per entry | 700 units | Fixed unless operator changes |
| Cash-out target | 1.30x | Fixed unless operator changes |
| Max daily entries | 100 | Hard transactional cap |
| Day boundary | UTC by default | Configurable |

## Architecture

Event-driven, domain-driven design with strict deterministic state machine:

```
Telegram Gateway -> Core Orchestrator (Event Bus) -> [
  Session Supervisor | Risk & Policy Engine | Bet Executor & Cash-Out Controller |
  Game Adapter & Round Observer | Balance Tracker | Daily Entry Ledger |
  Analytics / Learning Engine
] -> Persistence Layer (PostgreSQL + TimescaleDB + Redis + Encrypted Store)
  -> Playwright Browser Bridge
```

## Quick Start

### Prerequisites

- Node.js >= 20.0.0
- Docker & Docker Compose
- PostgreSQL 15+ with TimescaleDB extension
- Redis 7+

### Installation

```bash
# Clone and enter directory
cd crash-automation

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your values

# Start infrastructure services
docker compose -f docker/docker-compose.yml up -d db redis

# Run database migrations
npm run db:migrate

# Build the project
npm run build

# Start the application
npm start
```

### Development

```bash
# Run in development mode with tsx
npm run dev

# Run tests
npm run test

# Run linting
npm run lint

# Format code
npm run format
```

## Project Structure

```
src/
  config/          # Zod schemas, loader, defaults, validator
  core/            # Orchestrator, event-bus
  browser/         # Playwright lifecycle (future batches)
  game/            # Adapter, observer (future batches)
  betting/         # Executor, cash-out, risk-engine (future batches)
  ledger/          # Daily entries, balance tracker (future batches)
  telegram/        # Bot gateway, commands (future batches)
  analytics/       # Engine, metrics, learning (future batches)
  persistence/     # DB client, Redis client, transactions
  observability/   # Logger, metrics, tracing, health
  security/        # Crypto, secrets manager
  utils/           # Retry, time, errors, async helpers
  types/           # Global TypeScript definitions
tests/
  unit/            # Fast isolated logic tests
  integration/     # External service tests
  simulation/      # Mock game server scenarios
  e2e/             # Full-stack dry-run tests
migrations/        # SQL schema migrations
docker/            # Dockerfile, compose, provisioning
scripts/           # Operational scripts
docs/              # Architecture, runbooks, commands, math
```

## Safety Principles

1. **Safety Over Continuity**: Halt betting and alert the operator rather than guess during uncertain states.
2. **Deterministic Execution**: Stake (700) and target (1.30x) are immutable unless a cryptographically audited config change is pushed via Telegram with operator confirmation.
3. **Descriptive, Not Predictive**: Analytics measures historical reality and flags anomalies. It does NOT generate prediction models or guarantee profit.
4. **Auditability**: Every state transition, config change, and operator command is immutably logged.
5. **Fail-Safe Default**: If the system crashes, restarts, or loses confidence, it defaults to PAUSED or OBSERVE-ONLY, never auto-resumes live betting.

## Documentation

- [Architecture](docs/architecture.md)
- [Operational Runbooks](docs/runbooks.md)
- [Telegram Commands](docs/telegram-commands.md)
- [Analytics Mathematics](docs/analytics-math.md)

## License

UNLICENSED - Private use only.
