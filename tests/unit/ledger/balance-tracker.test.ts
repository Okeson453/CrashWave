import { BalanceTracker, resolveBestBalance } from '../../../src/ledger/balance-tracker';
import { BalanceSnapshot } from '../../../src/ledger/types';

describe('BalanceTracker', () => {
  let tracker: BalanceTracker;

  beforeEach(() => {
    tracker = new BalanceTracker({ reconciliationTolerance: 0.01 });
  });

  describe('recording', () => {
    it('records a snapshot', () => {
      tracker.record({ timestamp: new Date().toISOString(), balance: 5000, currencyOrUnit: 'USD', source: 'api' });
      expect(tracker.getCurrentBalance()).toBe(5000);
      expect(tracker.getCurrentSource()).toBe('api');
    });

    it('keeps latest snapshot', () => {
      tracker.record({ timestamp: new Date().toISOString(), balance: 5000, currencyOrUnit: 'USD', source: 'api' });
      tracker.record({ timestamp: new Date().toISOString(), balance: 4800, currencyOrUnit: 'USD', source: 'websocket' });
      expect(tracker.getCurrentBalance()).toBe(4800);
      expect(tracker.getCurrentSource()).toBe('websocket');
    });
  });

  describe('reconciliation', () => {
    it('matches when within tolerance', () => {
      const result = tracker.reconcile(5000.005, 5000);
      expect(result.matched).toBe(true);
      expect(result.withinTolerance).toBe(true);
    });

    it('mismatches when outside tolerance', () => {
      const result = tracker.reconcile(5100, 5000);
      expect(result.matched).toBe(false);
      expect(result.difference).toBe(100);
    });

    it('calculates expected balance after win', () => {
      const expected = tracker.calculateExpectedBalance(5000, 700, 210);
      expect(expected).toBe(5210);
    });

    it('calculates expected balance after loss', () => {
      const expected = tracker.calculateExpectedBalance(5000, 700, -700);
      expect(expected).toBe(4300);
    });

    it('returns unchanged when pnl is null', () => {
      const expected = tracker.calculateExpectedBalance(5000, 700, null);
      expect(expected).toBe(5000);
    });
  });

  describe('anomaly detection', () => {
    it('detects unexpected change', () => {
      const prev: BalanceSnapshot = { timestamp: new Date().toISOString(), balance: 5000, currencyOrUnit: 'USD', source: 'api' };
      const curr: BalanceSnapshot = { timestamp: new Date().toISOString(), balance: 5200, currencyOrUnit: 'USD', source: 'api' };
      const result = tracker.detectAnomaly(prev, curr, [0]);
      expect(result.anomaly).toBe(true);
      expect(result.unexplained).toBe(200);
    });

    it('passes when change is explained', () => {
      const prev: BalanceSnapshot = { timestamp: new Date().toISOString(), balance: 5000, currencyOrUnit: 'USD', source: 'api' };
      const curr: BalanceSnapshot = { timestamp: new Date().toISOString(), balance: 5210, currencyOrUnit: 'USD', source: 'api' };
      const result = tracker.detectAnomaly(prev, curr, [210]);
      expect(result.anomaly).toBe(false);
    });
  });

  describe('trend analysis', () => {
    it('detects upward trend', () => {
      for (let i = 0; i < 5; i++) {
        tracker.record({ timestamp: new Date(Date.now() + i * 1000).toISOString(), balance: 5000 + i * 100, currencyOrUnit: 'USD', source: 'api' });
      }
      const trend = tracker.getTrend(5);
      expect(trend.direction).toBe('up');
      expect(trend.averageChange).toBeGreaterThan(0);
    });

    it('detects downward trend', () => {
      for (let i = 0; i < 5; i++) {
        tracker.record({ timestamp: new Date(Date.now() + i * 1000).toISOString(), balance: 5000 - i * 100, currencyOrUnit: 'USD', source: 'api' });
      }
      const trend = tracker.getTrend(5);
      expect(trend.direction).toBe('down');
      expect(trend.averageChange).toBeLessThan(0);
    });

    it('detects flat trend', () => {
      for (let i = 0; i < 5; i++) {
        tracker.record({ timestamp: new Date(Date.now() + i * 1000).toISOString(), balance: 5000, currencyOrUnit: 'USD', source: 'api' });
      }
      const trend = tracker.getTrend(5);
      expect(trend.direction).toBe('flat');
    });
  });

  describe('range queries', () => {
    it('returns snapshots in range', () => {
      const now = Date.now();
      tracker.record({ timestamp: new Date(now - 2000).toISOString(), balance: 5000, currencyOrUnit: 'USD', source: 'api' });
      tracker.record({ timestamp: new Date(now - 1000).toISOString(), balance: 5100, currencyOrUnit: 'USD', source: 'api' });
      tracker.record({ timestamp: new Date(now).toISOString(), balance: 5200, currencyOrUnit: 'USD', source: 'api' });

      const range = tracker.getSnapshotsInRange(new Date(now - 1500), new Date(now - 500));
      expect(range).toHaveLength(1);
      expect(range[0].balance).toBe(5100);
    });

    it('finds snapshot before timestamp', () => {
      const now = Date.now();
      tracker.record({ timestamp: new Date(now - 2000).toISOString(), balance: 5000, currencyOrUnit: 'USD', source: 'api' });
      tracker.record({ timestamp: new Date(now).toISOString(), balance: 5200, currencyOrUnit: 'USD', source: 'api' });

      const before = tracker.getSnapshotBefore(new Date(now - 1000));
      expect(before?.balance).toBe(5000);
    });
  });

  describe('resolveBestBalance', () => {
    it('prefers api over ui', () => {
      const result = resolveBestBalance({ api: 5000, ui: 4900 });
      expect(result?.balance).toBe(5000);
      expect(result?.source).toBe('api');
    });

    it('falls back to ui when api missing', () => {
      const result = resolveBestBalance({ ui: 4900 });
      expect(result?.balance).toBe(4900);
      expect(result?.source).toBe('ui');
    });

    it('returns null when all missing', () => {
      const result = resolveBestBalance({});
      expect(result).toBeNull();
    });
  });
});
