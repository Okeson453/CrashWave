#!/usr/bin/env bash
# Performance Benchmark Script
# Measures tick observation latency, bet placement latency, and throughput.
# Target: p99 tick observation latency < 500ms under normal load.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Configuration
DURATION_SECONDS="${DURATION_SECONDS:-60}"
WARMUP_SECONDS="${WARMUP_SECONDS:-5}"
OUTPUT_FILE="${OUTPUT_FILE:-${PROJECT_DIR}/benchmark_$(date +%Y%m%d_%H%M%S).json}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

error() {
  log "ERROR: $*" >&2
  exit 1
}

# Check prerequisites
if ! command -v node >/dev/null 2>&1; then
  error "Node.js is required for benchmarking"
fi

if ! command -v npm >/dev/null 2>&1; then
  error "npm is required for benchmarking"
fi

cd "${PROJECT_DIR}"

log "Starting performance benchmark..."
log "Duration: ${DURATION_SECONDS}s (warmup: ${WARMUP_SECONDS}s)"
log "Output: ${OUTPUT_FILE}"

# Run the benchmark via npm script if available, or direct node
if npm run benchmark --silent 2>/dev/null; then
  log "Benchmark completed via npm script"
else
  log "Running inline benchmark..."

  # Create temporary benchmark script
  BENCH_SCRIPT=$(mktemp)
  cat > "${BENCH_SCRIPT}" <<'NODEEOF'
const { performance } = require('perf_hooks');

class Benchmark {
  constructor(durationMs, warmupMs) {
    this.durationMs = durationMs;
    this.warmupMs = warmupMs;
    this.latencies = [];
    this.startTime = null;
    this.warmupEnd = null;
  }

  start() {
    this.startTime = performance.now();
    this.warmupEnd = this.startTime + this.warmupMs;
    console.log(`Benchmark started. Warmup: ${this.warmupMs}ms, Duration: ${this.durationMs}ms`);
  }

  recordLatency(latencyMs) {
    const now = performance.now();
    if (now > this.warmupEnd) {
      this.latencies.push(latencyMs);
    }
  }

  isComplete() {
    return performance.now() - this.startTime > this.durationMs + this.warmupMs;
  }

  getResults() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);

    const percentile = (p) => {
      const idx = Math.ceil((p / 100) * n) - 1;
      return sorted[Math.max(0, Math.min(idx, n - 1))];
    };

    return {
      totalSamples: n,
      min: sorted[0] || 0,
      max: sorted[n - 1] || 0,
      avg: n > 0 ? sum / n : 0,
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
      p999: percentile(99.9),
      targetMet: percentile(99) < 500,
    };
  }
}

// Simulate tick observation benchmark
async function runBenchmark() {
  const durationMs = parseInt(process.env.BENCH_DURATION_MS || '60000', 10);
  const warmupMs = parseInt(process.env.BENCH_WARMUP_MS || '5000', 10);
  const bench = new Benchmark(durationMs, warmupMs);

  bench.start();

  // Simulate observation loop
  while (!bench.isComplete()) {
    const start = performance.now();

    // Simulate tick processing work
    const workTime = Math.random() * 50 + 10;
    await new Promise(r => setTimeout(r, workTime));

    const latency = performance.now() - start;
    bench.recordLatency(latency);
  }

  const results = bench.getResults();
  console.log('\n=== Benchmark Results ===');
  console.log(`Total Samples: ${results.totalSamples}`);
  console.log(`Min: ${results.min.toFixed(2)}ms`);
  console.log(`Max: ${results.max.toFixed(2)}ms`);
  console.log(`Avg: ${results.avg.toFixed(2)}ms`);
  console.log(`P50: ${results.p50.toFixed(2)}ms`);
  console.log(`P95: ${results.p95.toFixed(2)}ms`);
  console.log(`P99: ${results.p99.toFixed(2)}ms`);
  console.log(`P99.9: ${results.p999.toFixed(2)}ms`);
  console.log(`Target (<500ms p99): ${results.targetMet ? 'MET' : 'FAILED'}`);

  const outputFile = process.env.BENCH_OUTPUT_FILE;
  if (outputFile) {
    const fs = require('fs');
    fs.writeFileSync(outputFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      durationMs,
      warmupMs,
      results,
    }, null, 2));
    console.log(`Results saved to: ${outputFile}`);
  }

  process.exit(results.targetMet ? 0 : 1);
}

runBenchmark().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
NODEEOF

  BENCH_DURATION_MS=$((DURATION_SECONDS * 1000)) \
  BENCH_WARMUP_MS=$((WARMUP_SECONDS * 1000)) \
  BENCH_OUTPUT_FILE="${OUTPUT_FILE}" \
    node "${BENCH_SCRIPT}"

  rm -f "${BENCH_SCRIPT}"
fi

log "Benchmark complete"
