import {
  trace,
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';
import { safeAttributes } from './attributes.js';

const TRACER_NAME = 'digitalme-agent';

function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

function withParent(parent: Span) {
  return trace.setSpan(otelContext.active(), parent);
}

// ----- Child spans (synchronous within the turn) -----

export function startInteractionSpan(conversationId: string): Span {
  return getTracer().startSpan('agent.interaction', {
    kind: SpanKind.SERVER,
    attributes: {
      'conversation.id': conversationId,
    },
  });
}

export function startModelCallSpan(model: string, parent: Span): Span {
  return getTracer().startSpan('agent.model_call', {
    kind: SpanKind.CLIENT,
    attributes: {
      'model.name': model,
    },
  }, withParent(parent));
}

export function startToolSpan(toolName: string, parent: Span): Span {
  return getTracer().startSpan('agent.tool', {
    kind: SpanKind.INTERNAL,
    attributes: {
      'tool.name': toolName,
    },
  }, withParent(parent));
}

export function startSubagentSpan(subagentType: string, model: string, parent: Span): Span {
  return getTracer().startSpan('agent.subagent', {
    kind: SpanKind.INTERNAL,
    attributes: {
      'subagent.type': subagentType,
      'model.name': model,
    },
  }, withParent(parent));
}

// ----- Linked root spans (background work that outlives the turn) -----

export function startForkSpan(forkLabel: string, interactionCtx: SpanContext): Span {
  return getTracer().startSpan('agent.fork', {
    kind: SpanKind.INTERNAL,
    attributes: {
      'fork.label': forkLabel,
    },
    links: [{ context: interactionCtx }],
  });
}

export function startHookSpan(hookName: string, interactionCtx: SpanContext): Span {
  return getTracer().startSpan('agent.hook', {
    kind: SpanKind.INTERNAL,
    attributes: {
      'hook.name': hookName,
    },
    links: [{ context: interactionCtx }],
  });
}

// ----- End helpers -----

export function endSpan(span: Span, attributes?: Record<string, unknown>): void {
  if (attributes) {
    span.setAttributes(safeAttributes(attributes));
  }
  span.end();
}

export function endSpanWithError(span: Span, error: unknown, attributes?: Record<string, unknown>): void {
  if (attributes) {
    span.setAttributes(safeAttributes(attributes));
  }
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
  span.end();
}
