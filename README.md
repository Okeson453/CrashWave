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

## Environment Variables & Secrets Management

### Loading Secrets

The application supports two methods for providing secrets:

1. **Direct environment variables**: `DATABASE_URL`, `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `ENCRYPTION_KEY`, `TELEGRAM_OPERATOR_CHAT_ID`
2. **Docker secret files** (recommended for containers): Set `{KEY}_FILE` env vars pointing to files:
   ```bash
   docker run -e DATABASE_URL_FILE=/run/secrets/db_url myapp
   ```

The `secret-files.ts` module automatically resolves both patterns at startup via `hydrateSecretsFromFiles()`.

### Credential Encryption

**BC.Game credentials** (username, password, TOTP) are encrypted using AES-256-GCM in the `TenantSecretVault` class:

- **Master key** lives **only in process.env** (`TENANT_MASTER_KEY`), never in database
- Each encrypted value includes: `iv:authTag:ciphertext` (hex-encoded)
- Minimum master key length: 32 characters
- See `src/platform/secret-vault.ts` for encryption/decryption implementation

### Secrets Security Checklist

- ✅ Never commit `.env`, `credentials*.json`, or `*.pem` files
- ✅ Store `TENANT_MASTER_KEY` in secure vault (e.g., Azure Key Vault, AWS Secrets Manager)
- ✅ Use Docker secret files in production, not environment variables
- ✅ Rotate `TENANT_MASTER_KEY` periodically (re-encrypt all stored credentials)
- ✅ Review `src/security/` for audit trail and access control patterns

## npm Dependencies & Registry Configuration

### npm Registry & Lock File

This project uses a **consistent, audited package lock file** (`package-lock.json`) pinned to **npm@11** and **Node.js 22**:

- **Registry**: Always resolves to `https://registry.npmjs.org/` (public npm)
- **Integrity**: Every resolved package URL is locked with SRI hashes
- **Retry**: `.npmrc` configured with 5 retries, 10–60s timeout window

**Why this matters:**
- `npm ci` (used in Docker builds) **always uses exact `resolved` URLs from `package-lock.json`**, ignoring runtime registry config
- If the lockfile contains bad URLs (e.g., private mirrors), `npm ci` hangs indefinitely
- **Solution**: Regenerate lockfile from clean public registry if you ever edit `package.json`

### Updating Dependencies

```bash
# Update a single package (regenerates lockfile)
npm install package-name@latest

# Update all (careful — may introduce breaking changes)
npm update

# Verify lockfile is clean
npm install --package-lock-only --audit

# In Docker build, use npm@11 + retry/timeout settings
docker build .  # Uses Dockerfile registry config + .npmrc retries
```

## Docker & Deployment

### Build Process

The `Dockerfile` builds a multi-stage production image:

1. **Base**: `mcr.microsoft.com/playwright:v1.46.0-jammy` (includes system deps, avoids downloading Chromium)
2. **Install**: Node 22 + npm@11 (fixes npm 10.x bugs, adds retry resilience)
3. **Dependencies**: `npm ci --omit=dev` (~3 seconds with clean lockfile)
4. **Build**: TypeScript compilation + tree-shaking to `dist/`
5. **Runtime**: Minimal image with migrations, healthcheck, non-root user

### Key Dockerfile Settings

```dockerfile
# Playwright browser already in base image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Force public registry (overrides any local npm config)
RUN npm config set registry https://registry.npmjs.org/

# Safety net for missing TypeScript at build time
RUN test -f node_modules/.bin/tsc || npm install typescript@5.9.3 --no-save

# Healthcheck via HTTP
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
  CMD curl -sf "http://127.0.0.1:${PORT:-9090}/health" || exit 1
```

### GitHub Actions Deployment

The workflow (`.github/workflows/docker-build.yml`) automatically:
- Builds on every push to `main` (if src/, package.json, or Dockerfile changed)
- Pushes to GHCR: `ghcr.io/Okeson453/CrashWave/crash-automation:latest`
- Tags with commit SHA for full auditability

```bash
# Pull and run latest build
docker pull ghcr.io/Okeson453/CrashWave/crash-automation:latest
docker run -e DATABASE_URL_FILE=/run/secrets/db_url ghcr.io/Okeson453/CrashWave/crash-automation
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

## Troubleshooting

### npm Install Hangs (~38+ minutes)

**Symptom:** `npm ci` or `npm install` stalls after starting, eventually times out.

**Root cause:** `package-lock.json` contains `resolved` URLs pointing to an unavailable registry (e.g., internal mirror, broken IP).

**Fix:**
```bash
# Option 1: Regenerate lockfile from clean registry (safest)
rm package-lock.json
npm config set registry https://registry.npmjs.org/
npm install

# Option 2: Update .npmrc with retry settings
cat >> .npmrc << 'EOF'
registry=https://registry.npmjs.org/
fetch-retries=5
fetch-retry-mintimeout=10000
fetch-retry-maxtimeout=60000
EOF

# Then verify lockfile has no bad URLs
grep -c '35\.245\|192\.168' package-lock.json  # Should return 0
```

**Prevention:** Always check `.npmrc` for custom registries before running `npm install` locally. Regenerate `package-lock.json` only from the public registry.

### TypeScript Compile Error: "Cannot find module './secret-vault'"

**Symptom:** Docker build fails with:
```
src/platform/index.ts: Cannot find module './secret-vault.js'
```

**Root cause:** Source files are in `.gitignore` (e.g., overly broad patterns like `*secret*`).

**Fix:**
```bash
# Check what's ignored
git ls-files | grep -i secret  # Should show the files

# If empty, they're ignored. Review .gitignore
cat .gitignore | grep -E '\*secret|\*password|\*token'

# Make .gitignore more specific (see .gitignore in repo for example)
# Then add and commit the files
git add src/config/secret-files.ts src/platform/secret-vault.ts
git commit -m "Add secret handling source files"
```

### Docker Build Fails: "No such file or directory"

**Symptom:** `COPY` commands in Dockerfile fail with file not found.

**Root cause:** Files are untracked/ignored by git, so `docker build` (which uses `git ls-files`) doesn't see them.

**Fix:** Ensure all source files are committed to git:
```bash
git status  # Should show clean working tree
git ls-files | wc -l  # Should be > 100 files
```

### Application Crashes After Restart: "TENANT_MASTER_KEY not set"

**Symptom:** App starts but crashes when accessing encrypted credentials.

**Root cause:** `TENANT_MASTER_KEY` env var not provided or too short (< 32 chars).

**Fix:**
```bash
# Generate a strong 32+ character key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Set in .env or Docker secret
TENANT_MASTER_KEY=<generated-key-from-above>

# Restart app
npm start
```

### Healthcheck Fails: "curl: command not found"

**Symptom:** Healthcheck returns exit code 127, container marked unhealthy.

**Root cause:** Base image lacks `curl`. 

**Fix (already in Dockerfile):** Use `mcr.microsoft.com/playwright:v1.46.0-jammy` which includes curl. If you switch base images, ensure curl is installed:
```dockerfile
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
```

## Documentation

- [Architecture](docs/architecture.md)
- [Operational Runbooks](docs/runbooks.md)
- [Telegram Commands](docs/telegram-commands.md)
- [Analytics Mathematics](docs/analytics-math.md)

## License

UNLICENSED - Private use only.
