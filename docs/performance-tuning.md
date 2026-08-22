# Performance Tuning

## Tick Observation Latency

Target: P99 < 500ms

### Factors Affecting Latency
1. **Browser polling interval** - Lower interval = lower latency but higher CPU
2. **DOM complexity** - BC.Game UI complexity affects read time
3. **Network latency** - Connection to BC.Game servers
4. **System load** - CPU/memory pressure on host

### Tuning Parameters

```typescript
// GameAdapter poll interval
const adapter = new GameAdapter({
  pollIntervalMs: 50,  // Default: 100ms. Reduce for lower latency
});

// RoundObserver stale threshold
const observer = new RoundObserver({
  staleThresholdMs: 2000,  // Lower = faster stale detection
});
```

### Optimization Strategies
1. **Use headless browser** - Reduces rendering overhead
2. **Disable images** - Block unnecessary resources
3. **Reduce viewport** - Smaller viewport = less rendering
4. **CPU pinning** - Pin container to specific CPU cores
5. **Network proximity** - Deploy close to BC.Game servers

## Database Performance

### TimescaleDB Hypertable
Ticks are stored in a TimescaleDB hypertable for efficient time-series queries:

```sql
-- Create hypertable for ticks
SELECT create_hypertable('ticks', 'observed_at', chunk_time_interval => INTERVAL '1 day');
```

### Indexing
```sql
-- Essential indexes
CREATE INDEX idx_ticks_round_id ON ticks(round_id);
CREATE INDEX idx_bets_state ON bets(state);
CREATE INDEX idx_bets_daily_key ON bets(daily_key);
CREATE INDEX idx_rounds_external_id ON rounds(external_round_id);
```

### Connection Pooling
```typescript
const pool = new Pool({
  max: 20,        // Maximum connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

## Memory Management

### Browser Heap
Monitor browser heap size:
```typescript
const healthMonitor = new BrowserHealthMonitor({
  memoryThresholdMB: 512,  // Alert threshold
});
```

### Memory Leak Prevention
1. Clear event listeners on stop
2. Dispose of page resources
3. Restart browser periodically (every 4-6 hours)

## Throughput

### Expected Rates
- Rounds: ~6-20 per minute (depends on game speed)
- Ticks: ~100-500 per round
- Bets: Up to 100 per day (daily limit)

### Bottlenecks
1. **Database writes** - Batch tick inserts if needed
2. **Telegram API** - Rate limit: 30 messages/minute
3. **Browser DOM** - Single-threaded, can become bottleneck

## Benchmarking

Run performance benchmark:
```bash
./scripts/performance-benchmark.sh
```

Expected output:
```
=== Benchmark Results ===
Total Samples: 12000
Min: 12.34ms
Max: 456.78ms
Avg: 89.12ms
P50: 78.45ms
P95: 234.56ms
P99: 398.76ms
P99.9: 445.23ms
Target (<500ms p99): MET
```

## Scaling Considerations

The system is designed for single-instance operation. Horizontal scaling is not recommended because:
1. Browser automation is inherently single-instance
2. Betting requires single-writer semantics
3. Distributed coordination adds complexity

For higher availability, consider:
- Hot standby instance (manual failover)
- Database replication (read replicas for analytics)
- Redis Sentinel (for HA)
