export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface Span {
  traceId: string;
  spanId: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  status: 'OK' | 'ERROR' | 'UNSET';
  errorMessage?: string;
}

class InMemorySpanExporter {
  private spans: Span[] = [];

  export(span: Span): void {
    this.spans.push(span);
  }

  getSpans(): Span[] {
    return [...this.spans];
  }

  clear(): void {
    this.spans = [];
  }
}

const exporter = new InMemorySpanExporter();

export function getSpanExporter(): InMemorySpanExporter {
  return exporter;
}

export function createTraceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createSpanId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function startSpan(
  name: string,
  parentContext?: SpanContext,
  attributes: Record<string, unknown> = {}
): Span {
  const traceId = parentContext?.traceId || createTraceId();
  const span: Span = {
    traceId,
    spanId: createSpanId(),
    name,
    startTime: Date.now(),
    attributes,
    status: 'UNSET',
  };
  if (parentContext) {
    span.attributes['parentSpanId'] = parentContext.spanId;
  }
  return span;
}

export function endSpan(span: Span, status: 'OK' | 'ERROR' = 'OK', errorMessage?: string): void {
  span.endTime = Date.now();
  span.status = status;
  if (errorMessage) {
    span.errorMessage = errorMessage;
    span.attributes['error'] = errorMessage;
  }
  span.attributes['durationMs'] = (span.endTime || Date.now()) - span.startTime;
  exporter.export(span);
}

export function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  parentContext?: SpanContext,
  attributes: Record<string, unknown> = {}
): Promise<T> {
  const span = startSpan(name, parentContext, attributes);
  return fn()
    .then((result) => {
      endSpan(span, 'OK');
      return result;
    })
    .catch((error) => {
      endSpan(span, 'ERROR', error instanceof Error ? error.message : String(error));
      throw error;
    });
}

export function getCurrentTraceId(): string | undefined {
  const spans = exporter.getSpans();
  const last = spans[spans.length - 1];
  return last?.traceId;
}
