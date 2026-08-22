import { Pool } from 'pg';
import { getLogger } from '../../observability/logger';
import { EventBus } from './bus';

export class OutboxPublisher {
  private readonly logger = getLogger();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly eventBus: EventBus,
    private readonly intervalMs = 1000,
    private readonly batchSize = 50,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.publishBatch(), this.intervalMs);
    void this.publishBatch();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async publishBatch(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.pool.query<{
        event_id: string; event_type: string; payload: unknown;
        correlation_id: string; source: string;
      }>('SELECT * FROM claim_event_outbox($1)', [this.batchSize]);

      for (const row of result.rows) {
        try {
          await this.eventBus.emit({
            id: row.event_id,
            type: row.event_type as never,
            payload: row.payload,
            timestamp: new Date().toISOString(),
            correlationId: row.correlation_id,
            source: row.source,
          });
          await this.pool.query('SELECT mark_event_outbox_published($1)', [row.event_id]);
        } catch (error) {
          await this.pool.query('SELECT mark_event_outbox_failed($1,$2)', [row.event_id, String(error)]).catch(() => undefined);
          this.logger.error({ component: 'OutboxPublisher', eventId: row.event_id, error: String(error) }, 'Outbox publication failed');
        }
      }
    } catch (error) {
      this.logger.warn({ component: 'OutboxPublisher', error: String(error) }, 'Outbox poll failed');
    } finally {
      this.running = false;
    }
  }
}
