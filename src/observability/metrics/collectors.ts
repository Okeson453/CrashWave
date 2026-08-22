import {
  entriesTotal,
  entriesToday,
  pnlUnits,
  balanceUnits,
  betPlacementSuccessTotal,
  betPlacementFailureTotal,
  cashoutSuccessTotal,
  cashoutFailureTotal,
  multiplierTickLatency,
  browserProcessUp,
  authenticated,
  gameLoaded,
  websocketConnected,
  roundObservationConfidence,
  errorTotal,
  criticalErrorTotal,
  telegramNotificationSuccessTotal,
  telegramNotificationFailureTotal,
} from './registry';

export class MetricCollector {
  recordEntry(status: 'attempted' | 'confirmed' | 'failed'): void {
    entriesTotal.inc({ status });
    if (status === 'confirmed') {
      entriesToday.inc();
    }
  }

  setEntriesToday(count: number): void {
    entriesToday.set(count);
  }

  recordPnl(pnl: number, window: string = 'session'): void {
    pnlUnits.set({ window }, pnl);
  }

  setBalance(balance: number): void {
    balanceUnits.set(balance);
  }

  recordBetPlacement(success: boolean, reason?: string): void {
    if (success) {
      betPlacementSuccessTotal.inc();
    } else {
      betPlacementFailureTotal.inc({ reason: reason || 'unknown' });
    }
  }

  recordCashOut(success: boolean, reason?: string): void {
    if (success) {
      cashoutSuccessTotal.inc();
    } else {
      cashoutFailureTotal.inc({ reason: reason || 'unknown' });
    }
  }

  recordTickLatency(latencyMs: number): void {
    multiplierTickLatency.observe(latencyMs);
  }

  setBrowserProcessUp(up: boolean): void {
    browserProcessUp.set(up ? 1 : 0);
  }

  setAuthenticated(isAuthenticated: boolean): void {
    authenticated.set(isAuthenticated ? 1 : 0);
  }

  setGameLoaded(loaded: boolean): void {
    gameLoaded.set(loaded ? 1 : 0);
  }

  setWebsocketConnected(connected: boolean): void {
    websocketConnected.set(connected ? 1 : 0);
  }

  setObservationConfidence(confidence: 'low' | 'medium' | 'high'): void {
    const value = confidence === 'high' ? 2 : confidence === 'medium' ? 1 : 0;
    roundObservationConfidence.set(value);
  }

  recordError(severity: string, component: string): void {
    errorTotal.inc({ severity, component });
    if (severity === 'fatal' || severity === 'critical') {
      criticalErrorTotal.inc({ component });
    }
  }

  recordTelegramNotification(success: boolean, reason?: string): void {
    if (success) {
      telegramNotificationSuccessTotal.inc();
    } else {
      telegramNotificationFailureTotal.inc({ reason: reason || 'unknown' });
    }
  }
}

export const metricCollector = new MetricCollector();

// Detection-layer metric helpers attached for optional use
declare module './collectors' {
  interface MetricCollectorLike {
    recordProxyResolved?(provider: string): void;
    recordVelocityAction?(type: string): void;
    recordVelocityIdle?(ms: number): void;
    recordHumanizedClick?(): void;
    recordSessionConsistencyFailure?(reason: string): void;
    recordTelemetryNoiseApplied?(kind: string): void;
  }
}

const mc = metricCollector as typeof metricCollector & {
  recordProxyResolved?: (provider: string) => void;
  recordVelocityAction?: (type: string) => void;
  recordVelocityIdle?: (ms: number) => void;
  recordHumanizedClick?: () => void;
  recordSessionConsistencyFailure?: (reason: string) => void;
  recordTelemetryNoiseApplied?: (kind: string) => void;
  increment?: (name: string, labels?: Record<string, string>) => void;
  observe?: (name: string, value: number) => void;
};

mc.recordProxyResolved = function (provider: string) {
  try { mc.increment?.('proxy_resolved_total', { provider }); } catch { /* */ }
};
mc.recordVelocityAction = function (type: string) {
  try { mc.increment?.('velocity_action_total', { type }); } catch { /* */ }
};
mc.recordVelocityIdle = function (ms: number) {
  try { mc.observe?.('velocity_idle_ms', ms); } catch { /* */ }
};
mc.recordHumanizedClick = function () {
  try { mc.increment?.('humanized_click_total'); } catch { /* */ }
};
mc.recordSessionConsistencyFailure = function (reason: string) {
  try { mc.increment?.('session_consistency_failure_total', { reason }); } catch { /* */ }
};
mc.recordTelemetryNoiseApplied = function (kind: string) {
  try { mc.increment?.('telemetry_noise_applied_total', { kind }); } catch { /* */ }
};
