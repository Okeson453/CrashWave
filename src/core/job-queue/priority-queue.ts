/**
 * Bounded priority queue with retry/backoff and dead-letter hooks.
 * Redis Streams is the distributed transport; this queue is the local execution
 * primitive used inside a worker process.
 */
export type QueuePriority = 'critical' | 'high' | 'normal' | 'low' | 'background';
const PRIORITY_ORDER: QueuePriority[] = ['critical', 'high', 'normal', 'low', 'background'];
export interface QueueJob<T = unknown> { id: string; priority: QueuePriority; payload: T; createdAt: number; attempts: number; maxAttempts: number; availableAt: number; }
export interface QueueOptions { maxDepth?: number; concurrency?: number; retryBaseMs?: number; onDeadLetter?: (job: QueueJob, error: unknown) => Promise<void> | void; }

export class PriorityJobQueue<T = unknown> {
  private readonly buckets = new Map<QueuePriority, QueueJob<T>[]>();
  private readonly maxDepth: number;
  private readonly concurrency: number;
  private readonly retryBaseMs: number;
  private readonly onDeadLetter?: QueueOptions['onDeadLetter'];
  private active = 0;
  private handler: ((job: QueueJob<T>) => Promise<void>) | null = null;
  private pumping = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: QueueOptions = {}) {
    for (const p of PRIORITY_ORDER) this.buckets.set(p, []);
    this.maxDepth = options.maxDepth ?? 10_000;
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.retryBaseMs = options.retryBaseMs ?? 100;
    this.onDeadLetter = options.onDeadLetter;
  }
  onProcess(handler: (job: QueueJob<T>) => Promise<void>): void { this.handler = handler; void this.pump(); }
  enqueue(payload: T, priority: QueuePriority = 'normal', opts: { id?: string; maxAttempts?: number } = {}): string {
    if (this.depth() >= this.maxDepth) throw new Error('queue_depth_limit_exceeded');
    const id = opts.id ?? `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.buckets.get(priority)!.push({ id, priority, payload, createdAt: Date.now(), attempts: 0, maxAttempts: opts.maxAttempts ?? 3, availableAt: Date.now() });
    void this.pump();
    return id;
  }
  depth(): number { return PRIORITY_ORDER.reduce((n, p) => n + this.buckets.get(p)!.length, 0); }
  depthByPriority(): Record<QueuePriority, number> { return Object.fromEntries(PRIORITY_ORDER.map((p) => [p, this.buckets.get(p)!.length])) as Record<QueuePriority, number>; }

  private dequeue(): QueueJob<T> | null {
    const now = Date.now();
    for (const p of PRIORITY_ORDER) {
      const q = this.buckets.get(p)!;
      const idx = q.findIndex((j) => j.availableAt <= now);
      if (idx >= 0) return q.splice(idx, 1)[0];
    }
    return null;
  }
  private scheduleRetryPump(at: number): void {
    const delay = Math.max(0, at - Date.now());
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.pump();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async pump(): Promise<void> {
    if (this.pumping || !this.handler) return;
    this.pumping = true;
    try {
      while (this.active < this.concurrency) {
        const job = this.dequeue();
        if (!job) break;
        this.active++;
        void this.run(job);
      }
    } finally { this.pumping = false; }
  }
  private async run(job: QueueJob<T>): Promise<void> {
    try {
      job.attempts++;
      await this.handler!(job);
    } catch (error) {
      if (job.attempts < job.maxAttempts) {
        job.availableAt = Date.now() + this.retryBaseMs * 2 ** (job.attempts - 1);
        this.buckets.get(job.priority)!.push(job);
        this.scheduleRetryPump(job.availableAt);
      } else {
        await this.onDeadLetter?.(job, error);
      }
    } finally {
      this.active--;
      void this.pump();
    }
  }
}
