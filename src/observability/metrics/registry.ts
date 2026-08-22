import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

// Collect default Node.js metrics
collectDefaultMetrics({ register: metricsRegistry });

// Application metrics
export const entriesTotal = new Counter({
  name: 'crash_entries_total',
  help: 'Total number of entries attempted',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

export const entriesToday = new Gauge({
  name: 'crash_entries_today',
  help: 'Number of entries today',
  registers: [metricsRegistry],
});

export const pnlUnits = new Gauge({
  name: 'crash_pnl_units',
  help: 'Current P&L in units',
  labelNames: ['window'],
  registers: [metricsRegistry],
});

export const balanceUnits = new Gauge({
  name: 'crash_balance_units',
  help: 'Current balance in units',
  registers: [metricsRegistry],
});

export const betPlacementSuccessTotal = new Counter({
  name: 'crash_bet_placement_success_total',
  help: 'Total successful bet placements',
  registers: [metricsRegistry],
});

export const betPlacementFailureTotal = new Counter({
  name: 'crash_bet_placement_failure_total',
  help: 'Total failed bet placements',
  labelNames: ['reason'],
  registers: [metricsRegistry],
});

export const cashoutSuccessTotal = new Counter({
  name: 'crash_cashout_success_total',
  help: 'Total successful cash-outs',
  registers: [metricsRegistry],
});

export const cashoutFailureTotal = new Counter({
  name: 'crash_cashout_failure_total',
  help: 'Total failed cash-outs',
  labelNames: ['reason'],
  registers: [metricsRegistry],
});

export const multiplierTickLatency = new Histogram({
  name: 'crash_multiplier_tick_latency_ms',
  help: 'Latency of multiplier tick observation in ms',
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [metricsRegistry],
});

export const browserProcessUp = new Gauge({
  name: 'crash_browser_process_up',
  help: 'Whether the browser process is running (1=up, 0=down)',
  registers: [metricsRegistry],
});

export const authenticated = new Gauge({
  name: 'crash_authenticated',
  help: 'Whether the session is authenticated (1=yes, 0=no)',
  registers: [metricsRegistry],
});

export const gameLoaded = new Gauge({
  name: 'crash_game_loaded',
  help: 'Whether the game is loaded (1=yes, 0=no)',
  registers: [metricsRegistry],
});

export const websocketConnected = new Gauge({
  name: 'crash_websocket_connected',
  help: 'Whether the WebSocket is connected (1=yes, 0=no)',
  registers: [metricsRegistry],
});

export const roundObservationConfidence = new Gauge({
  name: 'crash_round_observation_confidence',
  help: 'Current round observation confidence (0=low, 1=medium, 2=high)',
  registers: [metricsRegistry],
});

export const errorTotal = new Counter({
  name: 'crash_error_total',
  help: 'Total errors',
  labelNames: ['severity', 'component'],
  registers: [metricsRegistry],
});

export const criticalErrorTotal = new Counter({
  name: 'crash_critical_error_total',
  help: 'Total critical errors',
  labelNames: ['component'],
  registers: [metricsRegistry],
});

export const telegramNotificationSuccessTotal = new Counter({
  name: 'crash_telegram_notification_success_total',
  help: 'Total successful Telegram notifications',
  registers: [metricsRegistry],
});

export const telegramNotificationFailureTotal = new Counter({
  name: 'crash_telegram_notification_failure_total',
  help: 'Total failed Telegram notifications',
  labelNames: ['reason'],
  registers: [metricsRegistry],
});

export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}

export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}
