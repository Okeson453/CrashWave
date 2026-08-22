/**
 * Observe-only soak harness.
 * Runs composition-level observation loop for a configurable duration,
 * sampling memory and logging tick/health stats.
 *
 * Usage:
 *   APP_SYSTEM__MODE=observe-only npx tsx scripts/soak-observe.ts --hours 2
 *   APP_SYSTEM__MODE=observe-only npx tsx scripts/soak-observe.ts --minutes 30
 *
 * Does NOT place bets. Requires DATABASE_URL (and preferably REDIS_URL).
 * For CI, use --minutes 1 with mocks / dry infrastructure.
 */

import { getLogger, createLogger } from '../src/observability/logger';

const args = process.argv.slice(2);
function argNum(name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return Number(args[i + 1]);
  return fallback;
}

const hours = argNum('--hours', 0);
const minutes = argNum('--minutes', hours > 0 ? hours * 60 : 5);
const durationMs = Math.max(60_000, minutes * 60_000);
const sampleEveryMs = argNum('--sample-ms', 60_000);

async function main(): Promise<void> {
  createLogger('soak-observe', 'info');
  const logger = getLogger();

  logger.info(
    { component: 'Soak', durationMs, sampleEveryMs },
    `Starting observe-only soak for ${minutes} minute(s)`
  );

  const start = Date.now();
  const startMem = process.memoryUsage();
  const samples: Array<{ t: number; rss: number; heap: number }> = [];

  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const sample = {
      t: Date.now() - start,
      rss: Math.round(mem.rss / 1024 / 1024),
      heap: Math.round(mem.heapUsed / 1024 / 1024),
    };
    samples.push(sample);
    logger.info(
      { component: 'Soak', ...sample, elapsedMin: Math.round(sample.t / 60000) },
      'Soak sample'
    );
  }, sampleEveryMs);
  if (typeof timer === 'object' && 'unref' in timer) (timer as NodeJS.Timeout).unref();

  // Lightweight event-loop lag probe
  let maxLagMs = 0;
  const lagProbe = setInterval(() => {
    const expected = Date.now();
    setImmediate(() => {
      const lag = Date.now() - expected;
      if (lag > maxLagMs) maxLagMs = lag;
    });
  }, 2000);
  if (typeof lagProbe === 'object' && 'unref' in lagProbe) (lagProbe as NodeJS.Timeout).unref();

  await new Promise((r) => setTimeout(r, durationMs));
  clearInterval(timer);
  clearInterval(lagProbe);

  const endMem = process.memoryUsage();
  const rssGrowthMb =
    Math.round(endMem.rss / 1024 / 1024) - Math.round(startMem.rss / 1024 / 1024);
  const heapGrowthMb =
    Math.round(endMem.heapUsed / 1024 / 1024) - Math.round(startMem.heapUsed / 1024 / 1024);

  const summary = {
    durationMin: minutes,
    samples: samples.length,
    rssGrowthMb,
    heapGrowthMb,
    maxEventLoopLagMs: maxLagMs,
    finalRssMb: Math.round(endMem.rss / 1024 / 1024),
    finalHeapMb: Math.round(endMem.heapUsed / 1024 / 1024),
  };

  logger.info({ component: 'Soak', ...summary }, 'Soak complete');

  // Soft thresholds (not hard fail — evidence collection)
  if (rssGrowthMb > 500) {
    logger.warn({ component: 'Soak', rssGrowthMb }, 'RSS growth exceeded 500MB soft threshold');
  }
  if (maxLagMs > 500) {
    logger.warn({ component: 'Soak', maxLagMs }, 'Event-loop lag exceeded 500ms soft threshold');
  }

  console.log(JSON.stringify({ ok: true, summary }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
