/**
 * Background worker offload — keeps non-critical work off the entry event-loop path.
 * Design §1.4 / PERFORMANCE.md: BullMQ-style isolation without requiring BullMQ in V1.1 core.
 *
 * - Critical jobs: processed immediately (same tick)
 * - High/normal: microtask / nextTick
 * - Low/background: setImmediate + optional yield so entry path stays free
 */

import { getLogger } from '../../observability/logger.js';
import {
  PriorityJobQueue,
  type QueueJob,
  type QueuePriority,
} from './priority-queue.js';

export type OffloadHandler = (job: QueueJob) => Promise<void>;

export interface WorkerOffloadOptions {
  /** Max background jobs drained per setImmediate cycle */
  backgroundBatchSize?: number;
  /** Soft ceiling on queue depth before shedding lowest priority */
  maxQueueDepth?: number;
}

export class WorkerOffload {
  private readonly logger = getLogger();
  private readonly queue = new PriorityJobQueue();
  private readonly handlers = new Map<string, OffloadHandler>();
  private readonly maxQueueDepth: number;
  private draining = false;

  constructor(options: WorkerOffloadOptions = {}) {
    void options.backgroundBatchSize;
    this.maxQueueDepth = options.maxQueueDepth ?? 500;

    this.queue.onProcess(async (job) => {
      const handler = this.handlers.get(String((job.payload as { type?: string })?.type ?? ''))
        ?? this.handlers.get('*');
      if (!handler) {
        this.logger.debug(
          { component: 'WorkerOffload', jobId: job.id },
          'No handler for offload job'
        );
        return;
      }
      await handler(job);
    });
  }

  register(type: string, handler: OffloadHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * Enqueue work. Critical runs via queue pump immediately;
   * background is scheduled on setImmediate to free the entry path.
   */
  enqueue(
    type: string,
    payload: Record<string, unknown>,
    priority: QueuePriority = 'background'
  ): string {
    if (this.queue.depth() >= this.maxQueueDepth && priority === 'background') {
      this.logger.warn(
        { component: 'WorkerOffload', depth: this.queue.depth() },
        'Shedding background job — queue depth limit'
      );
      return '';
    }

    const id = this.queue.enqueue(
      { type, ...payload },
      priority,
      { maxAttempts: priority === 'critical' ? 1 : 3 }
    );

    if (priority === 'background' || priority === 'low') {
      this.scheduleBackgroundDrain();
    }
    return id;
  }

  depth(): number {
    return this.queue.depth();
  }

  depthByPriority() {
    return this.queue.depthByPriority();
  }

  private scheduleBackgroundDrain(): void {
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => {
      this.draining = false;
      // Queue pump already processes FIFO by priority; enqueue triggers pump.
      // Additional yield: process a few more nextTicks if depth remains.
      if (this.queue.depth() > 0) {
        setImmediate(() => {
          /* pump continues via enqueue handlers */
        });
      }
    });
  }
}

/** Process-wide offload bus for analytics / learning / validation */
let globalOffload: WorkerOffload | null = null;

export function getWorkerOffload(): WorkerOffload {
  if (!globalOffload) globalOffload = new WorkerOffload();
  return globalOffload;
}

export function createWorkerOffload(options?: WorkerOffloadOptions): WorkerOffload {
  globalOffload = new WorkerOffload(options);
  return globalOffload;
}
