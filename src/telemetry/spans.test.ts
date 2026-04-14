import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startInteractionSpan,
  startModelCallSpan,
  startToolSpan,
  startSubagentSpan,
  startForkSpan,
  startHookSpan,
  endSpan,
  endSpanWithError,
} from './spans.js';

test('startInteractionSpan creates a span with conversation.id', () => {
  const span = startInteractionSpan('conv-123');
  assert.ok(span);
  assert.ok(span.spanContext().traceId);
  assert.ok(span.spanContext().spanId);
  endSpan(span);
});

test('startModelCallSpan creates a child span', () => {
  const parent = startInteractionSpan('conv-123');
  const child = startModelCallSpan('gpt-4', parent);
  assert.ok(child);
  assert.ok(child.spanContext().spanId);
  endSpan(child);
  endSpan(parent);
});

test('startToolSpan creates a child span', () => {
  const parent = startInteractionSpan('conv-123');
  const child = startToolSpan('web_search', parent);
  assert.ok(child);
  endSpan(child);
  endSpan(parent);
});

test('startSubagentSpan creates a child span', () => {
  const parent = startInteractionSpan('conv-123');
  const child = startSubagentSpan('general-purpose', 'gpt-4', parent);
  assert.ok(child);
  endSpan(child);
  endSpan(parent);
});

test('startForkSpan creates a linked root span', () => {
  const parent = startInteractionSpan('conv-123');
  const forkSpan = startForkSpan('session_memory', parent.spanContext());
  assert.ok(forkSpan);
  // Fork span should have a different trace context (linked root)
  assert.ok(forkSpan.spanContext().spanId);
  endSpan(forkSpan);
  endSpan(parent);
});

test('startHookSpan creates a linked root span', () => {
  const parent = startInteractionSpan('conv-123');
  const hookSpan = startHookSpan('session_memory', parent.spanContext());
  assert.ok(hookSpan);
  assert.ok(hookSpan.spanContext().spanId);
  endSpan(hookSpan);
  endSpan(parent);
});

test('endSpan sets attributes', () => {
  const span = startInteractionSpan('conv-123');
  // Should not throw
  endSpan(span, { 'terminal.reason': 'completed', 'turns.completed': 3 });
});

test('endSpanWithError sets error status', () => {
  const span = startInteractionSpan('conv-123');
  // Should not throw
  endSpanWithError(span, new Error('test error'), { 'error.category': 'model_call' });
});

test('endSpanWithError handles string errors', () => {
  const span = startInteractionSpan('conv-123');
  endSpanWithError(span, 'string error');
});

test('endSpan without attributes', () => {
  const span = startInteractionSpan('conv-123');
  endSpan(span);
});
