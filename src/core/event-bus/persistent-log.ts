import { BaseEvent } from '../../types/events';
import { getLogger } from '../../observability/logger';

export interface PersistentLogEntry {
  id: string;
  eventType: string;
  payload: unknown;
  timestamp: string;
  correlationId: string;
  source: string;
  persistedAt: string;
}

export interface PersistentLogWriter {
  write(entry: PersistentLogEntry): Promise<void>;
}

export class InMemoryPersistentLog implements PersistentLogWriter {
  private entries: PersistentLogEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 10000) {
    this.maxEntries = maxEntries;
  }

  async write(entry: PersistentLogEntry): Promise<void> {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  getEntries(): PersistentLogEntry[] {
    return [...this.entries];
  }

  getEntriesByType(eventType: string): PersistentLogEntry[] {
    return this.entries.filter((e) => e.eventType === eventType);
  }

  getEntriesByCorrelationId(correlationId: string): PersistentLogEntry[] {
    return this.entries.filter((e) => e.correlationId === correlationId);
  }

  getEntriesSince(timestamp: string): PersistentLogEntry[] {
    return this.entries.filter((e) => e.timestamp >= timestamp);
  }

  clear(): void {
    this.entries = [];
  }

  size(): number {
    return this.entries.length;
  }
}

export class ConsolePersistentLog implements PersistentLogWriter {
  async write(entry: PersistentLogEntry): Promise<void> {
    getLogger().info(
      { component: 'PersistentLog', eventType: entry.eventType, correlationId: entry.correlationId },
      `Event persisted: ${entry.eventType}`
    );
  }
}

export class CompositePersistentLog implements PersistentLogWriter {
  constructor(private writers: PersistentLogWriter[]) {}

  async write(entry: PersistentLogEntry): Promise<void> {
    await Promise.all(this.writers.map((w) => w.write(entry)));
  }
}

export function eventToLogEntry(event: BaseEvent): PersistentLogEntry {
  return {
    id: event.id,
    eventType: event.type,
    payload: event.payload,
    timestamp: event.timestamp,
    correlationId: event.correlationId,
    source: event.source,
    persistedAt: new Date().toISOString(),
  };
}
