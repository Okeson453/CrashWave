import { EventEmitter } from 'events';
import { BaseEvent, SystemEventType } from '../../types/events';
import { getLogger } from '../../observability/logger';
import {
  PersistentLogWriter,
  eventToLogEntry,
  InMemoryPersistentLog,
} from './persistent-log';

export type EventHandler<T = unknown> = (event: BaseEvent & { payload: T }) => Promise<void> | void;

export interface EventBusOptions {
  persistentLog?: PersistentLogWriter;
  maxListeners?: number;
}

export class EventBus {
  private emitter: EventEmitter;
  private persistentLog: PersistentLogWriter;
  private readonly logger = getLogger();

  constructor(options: EventBusOptions = {}) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(options.maxListeners ?? 100);
    this.persistentLog = options.persistentLog ?? new InMemoryPersistentLog();
  }

  setPersistentLog(writer: PersistentLogWriter): void {
    this.persistentLog = writer;
  }

  on<T>(eventType: SystemEventType, handler: EventHandler<T>): () => void {
    const wrappedHandler = async (event: BaseEvent): Promise<void> => {
      try {
        await handler(event as BaseEvent & { payload: T });
      } catch (error) {
        this.logger.error(
          {
            component: 'EventBus',
            eventType,
            correlationId: event.correlationId,
            error: error instanceof Error ? error.message : String(error),
          },
          `Event handler error for ${eventType}`
        );
      }
    };

    this.emitter.on(eventType, wrappedHandler);
    return () => this.emitter.off(eventType, wrappedHandler);
  }

  once<T>(eventType: SystemEventType, handler: EventHandler<T>): void {
    const wrappedHandler = async (event: BaseEvent): Promise<void> => {
      try {
        await handler(event as BaseEvent & { payload: T });
      } catch (error) {
        this.logger.error(
          {
            component: 'EventBus',
            eventType,
            correlationId: event.correlationId,
            error: error instanceof Error ? error.message : String(error),
          },
          `Event handler error for ${eventType}`
        );
      }
    };

    this.emitter.once(eventType, wrappedHandler);
  }

  async emit(event: BaseEvent): Promise<void> {
    this.logger.debug(
      {
        component: 'EventBus',
        eventType: event.type,
        correlationId: event.correlationId,
      },
      `Emitting event: ${event.type}`
    );

    // Persist the event first
    try {
      await this.persistentLog.write(eventToLogEntry(event));
    } catch (error) {
      this.logger.error(
        {
          component: 'EventBus',
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist event'
      );
    }

    // Emit to listeners
    this.emitter.emit(event.type, event);
  }

  async emitTyped<T extends SystemEventType>(
    type: T,
    payload: unknown,
    correlationId: string,
    source: string
  ): Promise<void> {
    const event: BaseEvent = {
      id: this.generateEventId(),
      type,
      payload,
      timestamp: new Date().toISOString(),
      correlationId,
      source,
    };
    await this.emit(event);
  }

  listenerCount(eventType: SystemEventType): number {
    return this.emitter.listenerCount(eventType);
  }

  removeAllListeners(eventType?: SystemEventType): void {
    if (eventType) {
      this.emitter.removeAllListeners(eventType);
    } else {
      this.emitter.removeAllListeners();
    }
  }

  getEventNames(): (string | symbol)[] {
    return this.emitter.eventNames();
  }

  private generateEventId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

let globalBus: EventBus | null = null;

export function createEventBus(options?: EventBusOptions): EventBus {
  globalBus = new EventBus(options);
  return globalBus;
}

export function getEventBus(): EventBus {
  if (!globalBus) {
    globalBus = createEventBus();
  }
  return globalBus;
}
