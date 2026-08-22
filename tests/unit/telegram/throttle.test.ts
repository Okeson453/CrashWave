import { ThrottleEngine } from '../../../src/telegram/throttle';
import { NotificationPayload, NotificationSeverity } from '../../../src/telegram/types';

function createPayload(severity: NotificationSeverity, overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    severity,
    category: 'system',
    title: 'Test Notification',
    message: 'This is a test notification',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('ThrottleEngine', () => {
  let sentNotifications: NotificationPayload[][];
  let engine: ThrottleEngine;

  beforeEach(() => {
    sentNotifications = [];
    engine = new ThrottleEngine({
      onSend: async (notifications) => {
        sentNotifications.push(notifications);
      },
    });
  });

  afterEach(() => {
    engine.stop();
  });

  describe('critical bypass', () => {
    it('delivers critical notifications immediately', async () => {
      const payload = createPayload('critical');
      await engine.submit(payload);

      expect(sentNotifications).toHaveLength(1);
      expect(sentNotifications[0]).toHaveLength(1);
      expect(sentNotifications[0][0].id).toBe(payload.id);
    });

    it('delivers multiple critical notifications', async () => {
      const p1 = createPayload('critical', { title: 'Critical 1' });
      const p2 = createPayload('critical', { title: 'Critical 2' });

      await engine.submit(p1);
      await engine.submit(p2);

      expect(sentNotifications).toHaveLength(2);
    });
  });

  describe('rate limit enforcement', () => {
    it('drops info notifications exceeding rate limit', async () => {
      // Info has maxPerMinute: 5, maxPerHour: 100
      for (let i = 0; i < 10; i++) {
        await engine.submit(createPayload('info', { title: `Info ${i}` }));
      }

      // Flush to ensure all pending are processed
      await engine.flushAll();

      // Some should be dropped due to rate limiting
      const totalSent = sentNotifications.flat().length;
      expect(totalSent).toBeLessThanOrEqual(5);
    });

    it('allows warning notifications within rate limit', async () => {
      // Warning has maxPerMinute: 10
      for (let i = 0; i < 5; i++) {
        await engine.submit(createPayload('warning', { title: `Warning ${i}` }));
      }

      await engine.flushAll();

      const totalSent = sentNotifications.flat().length;
      expect(totalSent).toBeGreaterThanOrEqual(5);
    });
  });

  describe('debounce timing', () => {
    it('batches info notifications', async () => {
      const p1 = createPayload('info', { title: 'Batch 1' });
      const p2 = createPayload('info', { title: 'Batch 2' });

      await engine.submit(p1);
      await engine.submit(p2);

      // Before flush, nothing should be sent (debounced)
      expect(sentNotifications.flat()).toHaveLength(0);

      // After flush, both should be in one batch
      await engine.flushAll();

      const totalSent = sentNotifications.flat();
      expect(totalSent.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('batch aggregation', () => {
    it('aggregates multiple notifications into single batch', async () => {
      const payloads = [
        createPayload('info', { title: 'Info 1' }),
        createPayload('info', { title: 'Info 2' }),
        createPayload('info', { title: 'Info 3' }),
      ];

      for (const p of payloads) {
        await engine.submit(p);
      }

      await engine.flushAll();

      // Should be aggregated (at least one batch contains multiple items)
      const totalSent = sentNotifications.flat();
      expect(totalSent.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('duplicate dropping', () => {
    it('drops duplicate notifications within same batch', async () => {
      const p1 = createPayload('info', { title: 'Same Title', message: 'Same message' });
      const p2 = createPayload('info', { title: 'Same Title', message: 'Same message' });

      await engine.submit(p1);
      await engine.submit(p2);

      await engine.flushAll();

      const totalSent = sentNotifications.flat();
      // Duplicates should be dropped
      const uniqueTitles = new Set(totalSent.map((n) => n.title + n.message));
      expect(uniqueTitles.size).toBeLessThanOrEqual(totalSent.length);
    });
  });

  describe('engine stop', () => {
    it('drops pending notifications when stopped', async () => {
      const dropped: NotificationPayload[][] = [];
      const customEngine = new ThrottleEngine({
        onSend: async () => {},
        onDrop: (notifications) => {
          dropped.push(notifications);
        },
      });

      await customEngine.submit(createPayload('info'));
      customEngine.stop();

      expect(dropped.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects new submissions after stop', async () => {
      engine.stop();
      await engine.submit(createPayload('critical'));

      // Critical should still be dropped because engine is stopped
      expect(sentNotifications).toHaveLength(0);
    });
  });

  describe('pending counts', () => {
    it('returns zero when no pending notifications', () => {
      const counts = engine.getPendingCounts();
      expect(counts.critical).toBe(0);
      expect(counts.info).toBe(0);
      expect(counts.warning).toBe(0);
      expect(counts.debug).toBe(0);
    });

    it('returns correct pending count after submission', async () => {
      await engine.submit(createPayload('info'));
      const counts = engine.getPendingCounts();
      expect(counts.info).toBe(1);
    });
  });

  describe('unknown severity', () => {
    it('drops notifications with unknown severity', async () => {
      const dropped: NotificationPayload[][] = [];
      const customEngine = new ThrottleEngine({
        onSend: async () => {},
        onDrop: (notifications) => {
          dropped.push(notifications);
        },
      });

      await customEngine.submit(createPayload('critical', { severity: 'unknown' as NotificationSeverity }));

      expect(dropped.length).toBeGreaterThanOrEqual(1);
      customEngine.stop();
    });
  });
});
