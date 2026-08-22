# ADR 002: Database Choice

## Status
Accepted

## Context
The system needs to persist session data, round history, tick data (time-series), bet records, and audit events. We needed to choose between PostgreSQL, TimescaleDB, MongoDB, and other options.

## Decision
We chose PostgreSQL with TimescaleDB extension for tick data.

## Alternatives Considered

### Option 1: MongoDB
- **Pros:** Flexible schema, easy to store nested tick arrays, good Node.js support
- **Cons:** No strong time-series optimization, eventual consistency concerns, less mature transaction support
- **Verdict:** Not ideal for time-series analytics

### Option 2: InfluxDB
- **Pros:** Purpose-built for time-series, excellent compression, fast queries
- **Cons:** Separate database to manage, less mature relational features, harder to join with bet data
- **Verdict:** Good for metrics but not for relational data

### Option 3: PostgreSQL + TimescaleDB (Chosen)
- **Pros:** Mature, ACID compliant, excellent Node.js support, TimescaleDB adds time-series optimization, single database for all data types
- **Cons:** Slightly more complex setup, TimescaleDB is an extension
- **Verdict:** Best balance of reliability, performance, and simplicity

### Option 4: SQLite
- **Pros:** Zero configuration, embedded, simple
- **Cons:** Not suitable for concurrent writes, no time-series support, limited scalability
- **Verdict:** Only suitable for development/testing

## Consequences

### Positive
- Single database for all persistence needs
- ACID transactions for bet placement (critical for financial data)
- TimescaleDB hypertables provide efficient time-series storage
- Rich query capabilities for analytics
- Well-supported in Docker ecosystem

### Negative
- Requires TimescaleDB extension installation
- More complex backup/restore procedure
- Connection pooling required for performance

## Schema Design
- **sessions** - Standard PostgreSQL table
- **rounds** - Standard PostgreSQL table
- **ticks** - TimescaleDB hypertable (partitioned by time)
- **bets** - Standard PostgreSQL table with JSONB for metadata
- **audit_events** - Append-only table with strict permissions
